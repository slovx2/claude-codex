import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'
import { Socket } from 'node:net'

// 父进程崩溃导致 EOF 时，CLI 可能把 MCP 断线当成工具错误继续请求模型。
// 守护进程保持 CLI 输入打开，先杀进程组，避免退出前再次调用模型。
const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error('缺少 Claude CLI 命令')
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
let closed = false
let stopping = false
let graceful = false
let inputEnded = false
const control = new Socket({ fd: 4, readable: true, writable: false })
control.on('data', (data: Buffer) => {
  if (data.toString() !== 'g') return
  graceful = true
  if (inputEnded) child.stdin.end()
})

const stop = (): void => {
  if (closed || stopping) return
  stopping = true
  if (process.platform === 'win32') {
    if (!child.pid) {
      process.exitCode = 1
      return
    }
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    killer.once('error', (error) => {
      process.stderr.write(String(error))
      process.exitCode = 1
    })
    return
  }
  // NativeProcess 以 detached=true 启动守护进程，CLI 和工具继承这一进程组。
  process.kill(-process.pid, 'SIGKILL')
}

process.stdin.pipe(child.stdin, { end: false })
process.stdin.once('end', () => {
  inputEnded = true
  if (graceful) child.stdin.end()
})
// 这个管道由适配器持有，不受 SDK 关闭 stdin 影响；父进程死亡时一定收到 EOF。
control.once('end', stop)
control.once('error', stop)
process.stdin.once('error', stop)
process.stdout.once('error', stop)
process.stderr.once('error', stop)
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
child.stdin.once('error', stop)
child.stdout.pipe(process.stdout, { end: false })
child.stderr.pipe(process.stderr, { end: false })
child.once('spawn', () =>
  writeSync(3, JSON.stringify({ childPid: child.pid }) + String.fromCharCode(10)),
)
child.once('error', (error) => {
  closed = true
  process.stderr.write(String(error))
  process.stdin.destroy()
  control.destroy()
  process.exitCode = 1
})
child.once('close', (code, signal) => {
  closed = true
  process.stdin.destroy()
  control.destroy()
  process.exitCode = code ?? (signal ? 1 : 0)
})
