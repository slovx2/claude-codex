import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { debugLog as sharedDebugLog } from '../packages/shared/src/util.mjs'
import { resolveCodexBinary } from '../src/util.mjs'

test('未运行 adapter main 的 Claude 入口仍记录共享模块日志', async () => {
  const previous = process.env.CLAUDE_CODEX_DEBUG_LOG
  const directory = await mkdtemp(join(tmpdir(), 'claude-shared-log-'))
  const path = join(directory, 'debug.jsonl')
  process.env.CLAUDE_CODEX_DEBUG_LOG = path
  try {
    sharedDebugLog('fs.review.test', { count: 1 })
    assert.equal(JSON.parse(await readFile(path, 'utf8')).event, 'fs.review.test')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODEX_DEBUG_LOG
    else process.env.CLAUDE_CODEX_DEBUG_LOG = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test('resolveCodexBinary prefers CODEX_REAL over PATH and homedir fallbacks', async () => {
  const previous = process.env.CODEX_REAL
  const directory = await mkdtemp(join(tmpdir(), 'claude-codex-util-'))
  const binary = join(directory, 'codex.real')
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  process.env.CODEX_REAL = binary
  try {
    assert.equal(resolveCodexBinary(), binary)
  } finally {
    if (previous == null) delete process.env.CODEX_REAL
    else process.env.CODEX_REAL = previous
    await rm(directory, { recursive: true, force: true })
  }
})
