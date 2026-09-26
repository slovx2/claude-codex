import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { saveArtifact } from './artifacts.mjs'

export type ModelRequest = Record<string, any>
export type ModelReply =
  | Array<Record<string, unknown>>
  | { status: number; message: string; errorType?: string; headers?: Record<string, string> }
  | { disconnect: true }
export type ModelStep = (request: ModelRequest) => ModelReply | Promise<ModelReply>

// 只替换模型 HTTP 接口。SDK、CLI、工具及会话文件都使用真实实现。
export class MockLLM {
  readonly requests: ModelRequest[] = []
  readonly unexpected: string[] = []
  private steps: ModelStep[] = []
  private server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as ModelRequest
      if (req.url === '/api/hello') {
        res.setHeader('Content-Type', 'application/json')
        res.end('{}')
        return
      }
      if (req.url?.startsWith('/v1/messages/count_tokens')) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ input_tokens: 100 }))
        return
      }
      const responsesAPI = req.url?.startsWith('/v1/responses') === true
      if (!req.url?.startsWith('/v1/messages') && !responsesAPI) {
        this.unexpected.push(req.url ?? '')
        res.writeHead(404).end()
        return
      }
      this.requests.push(body)
      const step = this.steps.shift()
      if (!step) throw new Error('收到未计划的模型请求')
      const reply = await step(body)
      if (!Array.isArray(reply)) {
        if ('disconnect' in reply) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('event: message_start\ndata: {')
          res.socket?.destroy()
        } else {
          res.writeHead(reply.status, {
            'Content-Type': 'application/json',
            'Retry-After': '0',
            ...reply.headers,
          })
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type:
                  reply.errorType ??
                  (reply.status === 401
                    ? 'authentication_error'
                    : reply.status === 429
                      ? 'rate_limit_error'
                      : 'api_error'),
                message: reply.message,
              },
            }),
          )
        }
        return
      }
      const content = reply
      if (responsesAPI) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const id = `resp_${randomUUID()}`
        this.event(res, 'response.created', { response: { id } })
        for (const item of content) {
          const output =
            item.type === 'tool_use'
              ? {
                  type: 'function_call',
                  call_id: item.id,
                  namespace: item.namespace ?? null,
                  name: item.name,
                  arguments: JSON.stringify(item.input),
                }
              : {
                  type: 'message',
                  id: `msg_${randomUUID()}`,
                  role: 'assistant',
                  content: [{ type: 'output_text', text: item.text }],
                }
          this.event(res, 'response.output_item.done', { item: output })
        }
        this.event(res, 'response.completed', {
          response: {
            id,
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              total_tokens: 120,
              input_tokens_details: null,
              output_tokens_details: null,
            },
          },
        })
        res.end()
        return
      }
      const stop = content.some((item) => item.type === 'tool_use') ? 'tool_use' : 'end_turn'
      const message = {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }
      if (!body.stream) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(message))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      this.event(res, 'message_start', { message: { ...message, content: [], stop_reason: null } })
      content.forEach((item, index) => {
        const block =
          item.type === 'text'
            ? { type: 'text', text: '' }
            : item.type === 'thinking'
              ? { type: 'thinking', thinking: '' }
              : { ...item, input: {} }
        this.event(res, 'content_block_start', { index, content_block: block })
        const delta =
          item.type === 'text'
            ? { type: 'text_delta', text: item.text }
            : item.type === 'thinking'
              ? { type: 'thinking_delta', thinking: item.thinking }
              : { type: 'input_json_delta', partial_json: JSON.stringify(item.input) }
        this.event(res, 'content_block_delta', { index, delta })
        this.event(res, 'content_block_stop', { index })
      })
      this.event(res, 'message_delta', {
        delta: { stop_reason: stop, stop_sequence: null },
        usage: message.usage,
      })
      this.event(res, 'message_stop', {})
      res.end()
    } catch (error) {
      this.unexpected.push(String(error))
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(error) } }),
      )
    }
  })
  private event(res: ServerResponse, type: string, body: Record<string, unknown>): void {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`)
  }
  enqueue(step: ModelStep): void {
    this.steps.push(step)
  }
  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Mock LLM 地址无效')
    return `http://127.0.0.1:${address.port}`
  }
  async close(): Promise<void> {
    await saveArtifact('model-requests', { requests: this.requests, unexpected: this.unexpected })
    this.server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    )
  }
  assertConsumed(): void {
    if (this.steps.length || this.unexpected.length)
      throw new Error(JSON.stringify({ remaining: this.steps.length, unexpected: this.unexpected }))
  }
}
