import { randomUUID } from 'node:crypto'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ProtocolError } from './protocol-contract.mjs'

// 一个 query 只持有一个输入迭代器，避免并发 streamInput 提前关闭 CLI stdin。
export class NativeTurnInput implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  private latestSteerId: string | null = null

  private readonly initial: AsyncIterable<SDKUserMessage>

  constructor(initial: AsyncIterable<SDKUserMessage>) {
    this.initial = initial
  }

  get isClosed(): boolean {
    return this.closed
  }

  steer(text: string): void {
    if (this.closed) throw new ProtocolError(-32009, '原生回合已结束，不能追加指令')
    const uuid = randomUUID()
    this.latestSteerId = uuid
    this.queue.push({
      type: 'user',
      uuid,
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    })
    this.wake?.()
  }

  consumedBy(result: Record<string, unknown>): boolean {
    if (!this.latestSteerId) return true
    const ids = Array.isArray(result.user_message_uuids) ? result.user_message_uuids : []
    return result.user_message_uuid === this.latestSteerId || ids.includes(this.latestSteerId)
  }

  close(): void {
    this.closed = true
    this.queue = []
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for await (const message of this.initial) {
      if (this.closed) return
      yield message
    }
    while (!this.closed) {
      const next = this.queue.shift()
      if (next) yield next
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      this.wake = null
    }
  }
}
