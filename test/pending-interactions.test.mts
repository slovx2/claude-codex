import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingInteractions } from '../src/pending-interactions.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'

function peer(id: string): RpcPeer & { messages: WireMessage[] } {
  const messages: WireMessage[] = []
  return {
    id,
    messages,
    send: (message) => {
      messages.push(message)
    },
    close: () => {},
  }
}

test('APPROVAL-001：相同请求 ID 不能由另一个连接回答，首次回答生效', async () => {
  const pending = new PendingInteractions(1000)
  const owner = peer('owner')
  const other = peer('other')
  const result = pending.request(owner, 'item/tool/call', 'same-id', { threadId: 'thread' })
  pending.resolve(other, { jsonrpc: '2.0', id: 'same-id', result: 'foreign' })
  pending.resolve(owner, { jsonrpc: '2.0', id: 'same-id', result: 'first' })
  pending.resolve(owner, { jsonrpc: '2.0', id: 'same-id', result: 'duplicate' })
  assert.equal(await result, 'first')
})

test('APPROVAL-002：超时、断线、中断与关闭使旧请求失效', async () => {
  const pending = new PendingInteractions(10)
  const owner = peer('owner')
  await assert.rejects(
    pending.request(owner, 'item/tool/call', 'timeout', { threadId: 'a' }),
    /超时/,
  )
  const disconnect = pending.request(owner, 'item/tool/call', 'disconnect', { threadId: 'a' })
  const disconnected = assert.rejects(disconnect, /连接已关闭/)
  pending.cancelPeer(owner.id)
  await disconnected
  const interrupt = pending.request(owner, 'item/tool/call', 'interrupt', { threadId: 'a' })
  const interrupted = assert.rejects(interrupt, /中断/)
  const unrelated = pending.request(owner, 'item/tool/call', 'unrelated', { threadId: 'b' })
  pending.cancelThread('a')
  pending.resolve(owner, { jsonrpc: '2.0', id: 'unrelated', result: 'ok' })
  await interrupted
  assert.equal(await unrelated, 'ok')
  const stopped = assert.rejects(
    pending.request(owner, 'item/tool/call', 'stop', { threadId: 'a' }),
    /停止/,
  )
  pending.close()
  pending.resolve(owner, { jsonrpc: '2.0', id: 'stop', result: 'late' })
  await stopped
})
