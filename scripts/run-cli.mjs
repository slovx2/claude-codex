#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const executable = fileURLToPath(
  new URL(
    `../bin/codex-harness-adapter${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url,
  ),
)
const child = spawn(executable, process.argv.slice(2), { stdio: 'inherit' })
child.on('error', (error) => {
  console.error(`请先运行 npm run build：${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
