import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FilesystemRpc } from '../src/filesystem-rpc.mjs'
import { ProtocolError } from '../src/protocol-contract.mjs'
import type { RpcPeer } from '../src/types.mjs'

test('文件参数错误不能截断文件或写入部分解码内容', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fs-rpc-'))
  const files = new FilesystemRpc()
  const peer: RpcPeer = { id: 'test', send() {}, close() {} }
  const path = join(home, 'data')
  try {
    await writeFile(path, 'KEEP')
    for (const dataBase64 of [undefined, null, 123, 'bad!', 'YWJj=']) {
      await assert.rejects(
        files.call(peer, 'fs/writeFile', { path, dataBase64 }),
        (error: unknown) => error instanceof ProtocolError && error.code === -32602,
      )
      assert.equal(await readFile(path, 'utf8'), 'KEEP')
    }
    await assert.rejects(files.call(peer, 'fs/readFile', { path: 'relative' }), ProtocolError)
    await assert.rejects(files.call(peer, 'fs/remove', { path, recursive: 'true' }), ProtocolError)
    assert.equal(await readFile(path, 'utf8'), 'KEEP')
    await files.call(peer, 'fs/writeFile', { path, dataBase64: '' })
    assert.equal((await readFile(path)).length, 0)
    await symlink(path, join(home, 'link'))
    const metadata: any = await files.call(peer, 'fs/getMetadata', { path: join(home, 'link') })
    assert.equal(metadata.isSymlink, true)
    assert.equal(metadata.isFile, true)
    assert.ok(Number.isInteger(metadata.modifiedAtMs))
  } finally {
    files.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('独立连接可使用同名 watch；重复启动和关闭不影响另一个连接', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fs-rpc-'))
  const files = new FilesystemRpc()
  const first: RpcPeer = { id: 'first', send() {}, close() {} }
  const second: RpcPeer = { id: 'second', send() {}, close() {} }
  const params = { path: home, watchId: 'shared' }
  try {
    await files.call(first, 'fs/watch', params)
    await files.call(second, 'fs/watch', params)
    await assert.rejects(files.call(first, 'fs/watch', params), ProtocolError)
    files.closePeer(first.id)
    await files.call(first, 'fs/watch', params)
    await assert.rejects(files.call(second, 'fs/watch', params), ProtocolError)
    await files.call(second, 'fs/unwatch', { watchId: 'shared' })
    await files.call(second, 'fs/watch', params)
  } finally {
    files.close()
    await rm(home, { recursive: true, force: true })
  }
})
