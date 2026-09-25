import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { debugLog } from './util.mjs'

// 控制请求超时并不等于 CLI 已停止；必须确认进程和管道关闭后才能释放审批。
export class NativeProcess {
  private child?: ChildProcessWithoutNullStreams
  private closed = false
  private exited: Promise<void> = Promise.resolve()
  private terminating: Promise<void> | undefined

  private readonly threadId: string
  private readonly turnId: string

  constructor(threadId: string, turnId: string) {
    this.threadId = threadId
    this.turnId = turnId
  }

  spawn(options: SpawnOptions): SpawnedProcess {
    if (this.child) throw new Error('同一个原生回合不能启动第二个 CLI')
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.child = child
    debugLog('native.process.started', {
      threadId: this.threadId,
      turnId: this.turnId,
      childPid: child.pid,
    })
    child.stderr.on('data', (data) => process.stderr.write(data))
    this.exited = new Promise<void>((resolve) => {
      child.once('close', () => {
        this.closed = true
        debugLog('native.process.closed', {
          threadId: this.threadId,
          turnId: this.turnId,
          childPid: child.pid,
        })
        resolve()
      })
    })
    return child
  }

  async wait(milliseconds: number): Promise<boolean> {
    return succeedsWithin(this.exited, milliseconds)
  }

  terminate(): Promise<void> {
    return (this.terminating ??= this.stopProcess().catch((error) => {
      // 保留进程身份与执行屏障；后续显式停止仍可重试。
      this.terminating = undefined
      throw error
    }))
  }

  private async stopProcess(): Promise<void> {
    if (!this.child || this.closed) return
    this.signal('SIGTERM')
    if (await this.wait(1_000)) return
    this.signal('SIGKILL')
    if (!(await this.wait(2_000))) throw new Error('Claude CLI 未能在期限内退出，禁止释放执行屏障')
  }

  private signal(signal: NodeJS.Signals): void {
    const child = this.child
    if (!child || this.closed || !child.pid) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

export async function succeedsWithin(
  work: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
