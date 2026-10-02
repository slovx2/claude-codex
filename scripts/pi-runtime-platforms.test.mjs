import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { platformPackages } from './pi-runtime-platforms.mjs'

test('裁剪嵌套外平台包，保留 Linux x64 glibc、通用依赖及 WASM', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-platforms-'))
  const add = (path, fields) => {
    const dir = join(root, path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: path, version: '1.0.0', ...fields }),
    )
    return dir
  }
  try {
    const sdk = add('sdk', {})
    const native = add('sdk/node_modules/@native/linux', {
      os: ['linux'],
      cpu: ['x64'],
      libc: ['glibc'],
    })
    const wasm = add('wasm', {})
    writeFileSync(join(wasm, 'image.wasm'), 'WASM')
    const wrong = [
      add('sdk/node_modules/@native/musl', { os: ['linux'], cpu: ['x64'], libc: ['musl'] }),
      add('sdk/node_modules/@native/mac', { os: ['darwin'], cpu: ['x64'] }),
      add('arm', { os: ['linux'], cpu: ['arm64'] }),
      add('not-linux', { os: ['!linux'] }),
    ]
    assert.throws(() => platformPackages(root), /其他平台包/)
    assert.equal(platformPackages(root, { prune: true }).removed.length, 4)
    for (const dir of wrong) assert.equal(existsSync(dir), false)
    for (const dir of [sdk, native, wasm]) assert.equal(existsSync(dir), true)
    assert.equal(platformPackages(root).removed.length, 0)
    assert.throws(() => platformPackages(root, { smoke: true }), /缺少.*esbuild/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
