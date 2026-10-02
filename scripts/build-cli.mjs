import { spawnSync } from 'node:child_process'

const target = `bin/codex-harness-adapter${process.platform === 'win32' ? '.exe' : ''}`
const result = spawnSync('go', ['build', '-o', target, './cmd/codex-harness-adapter'], {
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
