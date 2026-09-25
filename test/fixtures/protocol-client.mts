import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { saveArtifact } from './artifacts.mjs'
import { validatePayload } from './schema-contract.mjs'

export class ProtocolClient {
  readonly trace: any[] = []
  stderr = ''
  private readonly home: string
  private readonly modelEndpoint: string
  private protocolErrors: Error[] = []
  readonly process: ChildProcessWithoutNullStreams
  private sequence = 0
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >()
  onTool: ((params: any) => Promise<unknown>) | null = null
  onServerRequest: ((method: string, params: any) => Promise<unknown>) | null = null

  private constructor(home: string, baseURL: string, mock: boolean) {
    this.home = home
    const endpoint = new URL(baseURL)
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error('协议测试只能连接回环 Mock LLM')
    this.modelEndpoint = endpoint.origin
    // 白名单环境，不能继承个人模型凭据、代理或 Claude 配置。
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: home,
      CODEX_HOME: join(home, 'codex'),
      CLAUDE_CODEX_HOME: join(home, 'adapter'),
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      ANTHROPIC_API_KEY: 'test-not-a-secret',
      ANTHROPIC_BASE_URL: baseURL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODEX_RUNTIME: mock ? 'mock' : 'agent-sdk-sidecar',
      CLAUDE_CODEX_MOCK: mock ? '1' : '0',
      CLAUDE_CODEX_DEFAULT_MODEL: 'claude-sonnet-4-6',
      NODE_NO_WARNINGS: '1',
      CLAUDE_CODEX_SDK_DEBUG: '1',
      DEBUG_CLAUDE_AGENT_SDK: '1',
    }
    this.process = spawn(process.execPath, [resolve('dist/src/adapter.mjs'), 'app-server'], { env })
    this.process.stderr.on('data', (chunk) => {
      this.stderr += String(chunk)
    })
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      this.trace.push(message)
      if (message.method) {
        try {
          validatePayload(message.method, 'Params', message.params)
        } catch (error) {
          this.protocolErrors.push(error as Error)
        }
      }
      if (message.method && message.id != null) {
        const handler =
          this.onServerRequest ??
          (message.method === 'item/tool/call' && this.onTool
            ? (_method: string, params: any) => this.onTool!(params)
            : null)
        if (!handler) {
          this.send({ id: message.id, error: { code: -32601, message: '测试端未实现回调' } })
          return
        }
        validatePayload(message.method, 'Params', message.params)
        void handler(message.method, message.params)
          .then((result) => {
            validatePayload(message.method, 'Response', result)
            this.send({ id: message.id, result })
          })
          .catch((error) => {
            this.protocolErrors.push(error as Error)
            this.send({ id: message.id, error: { code: -32000, message: String(error) } })
          })
        return
      }
      const waiter = this.pending.get(message.id)
      if (waiter) {
        this.pending.delete(message.id)
        waiter.resolve(message)
      }
    })
    this.process.on('exit', (code) => {
      for (const waiter of this.pending.values())
        waiter.reject(new Error(`适配器退出 ${code}: ${this.stderr}`))
      this.pending.clear()
    })
  }
  static async start(home: string, baseURL: string, mock = false): Promise<ProtocolClient> {
    await mkdir(join(home, 'claude'), { recursive: true })
    const client = new ProtocolClient(home, baseURL, mock)
    try {
      await client.request('initialize', {
        clientInfo: { name: 'protocol-test', title: null, version: '1.0.0' },
        capabilities: null,
      })
    } catch (error) {
      await client.close()
      throw error
    }
    return client
  }
  private send(value: unknown, expectedErrorCode?: number): void {
    this.trace.push({
      direction: 'client',
      ...(value as Record<string, unknown>),
      ...(expectedErrorCode === undefined ? {} : { expectedErrorCode }),
    })
    this.process.stdin.write(`${JSON.stringify(value)}\n`)
  }
  async raw(method: string, params: unknown = {}, expectedErrorCode?: number): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC 超时 ${method}: ${this.stderr}`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          if (
            expectedErrorCode !== undefined &&
            (value.error?.code !== expectedErrorCode || 'result' in value)
          ) {
            reject(
              new Error(`RPC ${method} 应拒绝为 ${expectedErrorCode}: ${JSON.stringify(value)}`),
            )
            return
          }
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.send({ id, method, params }, expectedErrorCode)
    })
  }
  async request(method: string, params: unknown = {}): Promise<any> {
    validatePayload(method, 'Params', params)
    const response = await this.raw(method, params)
    if (response.error) throw new Error(JSON.stringify(response.error))
    validatePayload(method, 'Response', response.result)
    return response.result
  }
  async completed(turnId: string): Promise<any> {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (this.protocolErrors.length) throw this.protocolErrors[0]
      const message = this.trace.find(
        (item) => item.method === 'turn/completed' && item.params.turn.id === turnId,
      )
      if (message) return message.params.turn
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`Turn 超时: ${this.stderr}\n${JSON.stringify(this.trace.slice(-8))}`)
  }
  async notification(
    method: string,
    predicate: (params: any) => boolean = () => true,
  ): Promise<any> {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (this.protocolErrors.length) throw this.protocolErrors[0]
      const message = this.trace.find((item) => item.method === method && predicate(item.params))
      if (message) return message.params
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`通知超时 ${method}: ${this.stderr}`)
  }
  async close(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      const exited = new Promise<void>((resolve) => this.process.once('exit', () => resolve()))
      this.process.kill('SIGTERM')
      await exited
    }
    // CLI 将部分连接错误写入配置目录，stderr 可能为空；只读本用例的临时目录。
    const debugDirectory = join(this.home, 'claude', 'debug')
    const debugFiles = await readdir(debugDirectory, { withFileTypes: true }).catch(() => [])
    const debugLogs: Record<string, string> = {}
    for (const file of debugFiles.filter((entry) => entry.isFile()).slice(-16)) {
      const contents = await readFile(join(debugDirectory, file.name), 'utf8')
      debugLogs[file.name] = this.redactDiagnostics(contents.slice(-128_000))
    }
    // 子进程只接收白名单测试环境；保存诊断用于区分协议失败与 SDK 启动/沙箱失败。
    await saveArtifact('runtime-diagnostics', {
      modelEndpoint: this.modelEndpoint,
      stderr: this.redactDiagnostics(this.stderr.slice(-128_000)),
      debugLogs,
    })
    await saveArtifact('wire', {
      messages: this.trace,
      protocolErrors: this.protocolErrors.map((error) => error.message),
    })
  }
  private redactDiagnostics(value: string): string {
    return value
      .replace(
        /^.*(?:authorization|api.?key|access.?token|refresh.?token|password|secret).*$/gim,
        '[redacted]',
      )
      .replaceAll('test-not-a-secret', '[redacted]')
  }
}
