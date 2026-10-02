import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { PiStore } from '../src/store.mjs'

test('Pi 拒绝旧适配数据库且不改写文件，新格式可重新打开', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cha-pi-format-'))
  const path = join(home, 'adapter.sqlite')
  try {
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE threads(id TEXT)')
    old.close()
    const before = await readFile(path)
    assert.throws(() => new PiStore(home), /旧适配器数据库不受支持/)
    assert.deepEqual(await readFile(path), before)
    await rm(path)
    const fresh = new PiStore(home)
    fresh.db.close()
    const reopened = new PiStore(home)
    assert.deepEqual(reopened.threads(), [])
    reopened.db.close()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
