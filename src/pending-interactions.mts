import { ProtocolError } from './protocol-contract.mjs'
import type { JsonRpcResponse, RpcPeer } from './types.mjs'

interface PendingInteraction {
  peerId: string
  threadId: string
  finish(response?: JsonRpcResponse, error?: Error): void
}

// Hub 仲裁多端答案；适配器仅接受发出请求的 Hub 连接的首次有效回答。
export class PendingInteractions {
  private pending = new Map<string, PendingInteraction>()

  constructor(privateTimeoutMs = 120_000) {
    if (!Number.isSafeInteger(privateTimeoutMs) || privateTimeoutMs < 1)
      throw new Error('交互超时必须为正整数')
    this.timeoutMs = privateTimeoutMs
  }
  private readonly timeoutMs: number

  request(
    peer: RpcPeer,
    method: string,
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onFinished?: () => void,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new ProtocolError(-32010, '交互请求已取消'))
    const key = JSON.stringify([peer.id, id])
    if (this.pending.has(key)) throw new ProtocolError(-32009, '交互请求 ID 冲突')
    const threadId = String((params as Record<string, unknown>).threadId ?? '')
    return new Promise((resolve, reject) => {
      const finish = (response?: JsonRpcResponse, error?: Error) => {
        if (!this.pending.delete(key)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancelled)
        // 在唤醒等待者前发送结束事件，崩溃和取消也使用同一个完成路径。
        try {
          onFinished?.()
        } catch (notificationError) {
          error ??=
            notificationError instanceof Error
              ? notificationError
              : new Error(String(notificationError))
        }
        if (error) reject(error)
        else if (response?.error)
          reject(new ProtocolError(response.error.code, response.error.message))
        else resolve(response?.result)
      }
      const cancelled = () => finish(undefined, new ProtocolError(-32010, '交互请求已取消'))
      const timer = setTimeout(
        () => finish(undefined, new ProtocolError(-32010, '交互请求超时，结果未确认')),
        this.timeoutMs,
      )
      this.pending.set(key, { peerId: peer.id, threadId, finish })
      signal?.addEventListener('abort', cancelled, { once: true })
      try {
        peer.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  resolve(peer: RpcPeer, response: JsonRpcResponse): void {
    this.pending.get(JSON.stringify([peer.id, String(response.id)]))?.finish(response)
  }

  cancelPeer(peerId: string): void {
    this.cancel((entry) => entry.peerId === peerId, '交互连接已关闭，结果未确认')
  }

  cancelThread(threadId: string): void {
    this.cancel((entry) => entry.threadId === threadId, 'Turn 已中断，交互请求失效')
  }

  close(): void {
    this.cancel(() => true, '运行时停止，交互请求失效')
  }

  private cancel(predicate: (entry: PendingInteraction) => boolean, message: string): void {
    for (const entry of this.pending.values())
      if (predicate(entry)) entry.finish(undefined, new ProtocolError(-32010, message))
  }
}
