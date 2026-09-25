import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ElicitRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { sdkMcpServers, sdkMcpStartupEnvironment } from './mcp-config.mjs'
import type { RuntimeHandlers } from './types.mjs'

// 连接仍进入真实 SDK 的 MCP 工具执行链；交互直接回到 Hub，避免 CLI 丢弃 URL 和元数据。
export class NativeMcpBridge {
  private readonly clients = new Map<string, Client>()
  private readonly closing = new Map<Client, Promise<void>>()
  private closed = false

  async connect(
    raw: unknown,
    cwd: string,
    handlers: Pick<RuntimeHandlers, 'onElicitationRequest'>,
    signal: AbortSignal,
  ): Promise<Record<string, McpSdkServerConfigWithInstance>> {
    const result: Record<string, McpSdkServerConfigWithInstance> = {}
    const timeout = Number(sdkMcpStartupEnvironment(raw).MCP_TIMEOUT ?? 30_000)
    for (const [name, config] of Object.entries(sdkMcpServers(raw))) {
      signal.throwIfAborted()
      const client = new Client(
        { name: 'claude-codex-adapter', version: '0.1.0' },
        {
          capabilities: { elicitation: { form: {}, url: {} } },
        },
      )
      this.clients.set(name, client)
      client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        const combined = AbortSignal.any([signal, extra.signal])
        combined.throwIfAborted()
        if (!handlers.onElicitationRequest) throw new Error('MCP 交互处理器未注册')
        const response = await handlers.onElicitationRequest(
          { ...request.params, mode: request.params.mode ?? 'form', serverName: name },
          combined,
        )
        combined.throwIfAborted()
        return response
      })
      const cancel = () => {
        void this.closeClient(client).catch(() => {})
      }
      signal.addEventListener('abort', cancel, { once: true })
      client.onclose = () => signal.removeEventListener('abort', cancel)
      await client.connect(mcpTransport(config, cwd, signal), { signal, timeout })
      if (this.closed) throw new Error('MCP 运行时已关闭')
      signal.throwIfAborted()
      const capabilities = client.getServerCapabilities() ?? {}
      const instructions = client.getInstructions()
      const instance = new McpServer(client.getServerVersion() ?? { name, version: '1.0.0' }, {
        capabilities: {
          tools: {},
          ...(capabilities.resources ? { resources: {} } : {}),
          ...(capabilities.prompts ? { prompts: {} } : {}),
        },
        ...(instructions === undefined ? {} : { instructions }),
      })
      const options = (requestSignal: AbortSignal) => ({
        signal: AbortSignal.any([signal, requestSignal]),
        timeout: config.timeout ?? 120_000,
      })
      instance.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        if (!capabilities.tools) return { tools: [] }
        const listed = await client.listTools(request.params, options(extra.signal))
        return {
          ...listed,
          tools: listed.tools.map((tool) => ({
            ...tool,
            _meta: { ...tool._meta, 'anthropic/alwaysLoad': true },
          })),
        }
      })
      instance.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
        client.callTool(request.params, undefined, options(extra.signal)),
      )
      if (capabilities.resources) {
        instance.server.setRequestHandler(ListResourcesRequestSchema, (request, extra) =>
          client.listResources(request.params, options(extra.signal)),
        )
        instance.server.setRequestHandler(ListResourceTemplatesRequestSchema, (request, extra) =>
          client.listResourceTemplates(request.params, options(extra.signal)),
        )
        instance.server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
          client.readResource(request.params, options(extra.signal)),
        )
      }
      if (capabilities.prompts) {
        instance.server.setRequestHandler(ListPromptsRequestSchema, (request, extra) =>
          client.listPrompts(request.params, options(extra.signal)),
        )
        instance.server.setRequestHandler(GetPromptRequestSchema, (request, extra) =>
          client.getPrompt(request.params, options(extra.signal)),
        )
      }
      result[name] = {
        type: 'sdk',
        name,
        instance,
        ...(config.timeout ? { timeout: config.timeout } : {}),
      }
    }
    return result
  }

  async close(): Promise<void> {
    this.closed = true
    const clients = [...this.clients.values()]
    this.clients.clear()
    for (const client of clients) this.closeClient(client)
    await Promise.all(this.closing.values())
  }

  private closeClient(client: Client): Promise<void> {
    // SDK transport 的第二次 close 会立即返回；必须复用首次关闭的完成屏障。
    let pending = this.closing.get(client)
    if (!pending) {
      pending = client.close()
      this.closing.set(client, pending)
    }
    return pending
  }

  client(name: string): Client {
    const client = this.clients.get(name)
    if (!client || this.closed) throw new Error('MCP 连接未建立或已关闭')
    return client
  }
}

function mcpTransport(config: Record<string, any>, cwd: string, signal: AbortSignal): Transport {
  if (config.type === 'stdio')
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd,
      stderr: 'inherit',
    })
  const requestInit = { headers: config.headers }
  const fetchWithSignal: typeof fetch = (input, init) => {
    // MCP SDK 会把 signal 放在 Request 对象里；覆盖它会让关闭后的 SSE 持续挂起。
    const signals = [signal]
    if (input instanceof Request) signals.push(input.signal)
    if (init?.signal) signals.push(init.signal)
    return fetch(input, {
      ...init,
      signal: AbortSignal.any(signals),
    })
  }
  if (config.type === 'sse')
    return new SSEClientTransport(new URL(config.url), {
      requestInit,
      fetch: fetchWithSignal,
    })
  // 固定 MCP SDK 的 class 与接口对 sessionId 可选性的声明不一致。
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit,
    fetch: fetchWithSignal,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  }) as unknown as Transport
}
