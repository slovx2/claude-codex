import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sandboxCommand } from './command-sandbox.mjs'
import { decodeBase64 } from './filesystem-rpc.mjs'
import { ProtocolError, requiredString } from './protocol-contract.mjs'
import { commandEnv } from './server-helpers.mjs'
import type { RpcPeer } from './types.mjs'
import { debugLog } from './util.mjs'

interface ProcessRecord {
  child: ChildProcess
  tty: boolean
  stdin: boolean
  stopped: boolean
  killTimer?: NodeJS.Timeout
}

function integer(value: unknown, name: string, fallback: number): number {
  if (value == null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ProtocolError(-32602, `${name} 必须为非负整数`)
  return value
}

function terminalSize(value: unknown): { rows: number; cols: number } {
  if (!value || typeof value !== 'object') throw new ProtocolError(-32602, '缺少终端尺寸')
  const size = value as Record<string, unknown>
  const rows = integer(size.rows, 'rows', 0)
  const cols = integer(size.cols, 'cols', 0)
  if (!rows || !cols || rows > 65535 || cols > 65535)
    throw new ProtocolError(-32602, '终端尺寸必须在 1 到 65535 之间')
  return { rows, cols }
}

export class ProcessRpc {
  private owned = new Map<string, Map<string, ProcessRecord>>()
  private reaping = new Set<Promise<void>>()

  async start(
    peer: RpcPeer,
    kind: 'command' | 'process',
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const field = kind === 'command' ? 'processId' : 'processHandle'
    const tty = params.tty === true
    const stdin = tty || params.streamStdin === true
    const streaming = tty || params.streamStdoutStderr === true
    for (const key of [
      'tty',
      'streamStdin',
      'streamStdoutStderr',
      'disableTimeout',
      'disableOutputCap',
    ])
      if (params[key] != null && typeof params[key] !== 'boolean')
        throw new ProtocolError(-32602, `${key} 必须为布尔值`)
    const id =
      kind === 'command' && params[field] == null && !stdin && !streaming
        ? randomUUID()
        : requiredString(params[field], field)
    const key = `${kind}:${id}`
    const records = this.owned.get(peer.id) ?? new Map<string, ProcessRecord>()
    if (records.has(key)) throw new ProtocolError(-32602, `${field} 已在当前连接使用`)
    let command = params.command
    if (
      !Array.isArray(command) ||
      !command.length ||
      command.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    )
      throw new ProtocolError(-32602, 'command 必须是非空 argv 字符串数组')
    const cwd =
      params.cwd == null && kind === 'command' ? process.cwd() : requiredString(params.cwd, 'cwd')
    if (!isAbsolute(cwd)) throw new ProtocolError(-32602, 'cwd 必须是绝对路径')
    if (params.size != null && !tty) throw new ProtocolError(-32602, 'size 只能用于 PTY')
    const size = terminalSize(params.size ?? { rows: 24, cols: 80 })
    if (params.disableTimeout === true && params.timeoutMs != null)
      throw new ProtocolError(-32602, 'disableTimeout 与 timeoutMs 不能同时使用')
    if (params.disableOutputCap === true && params.outputBytesCap != null)
      throw new ProtocolError(-32602, 'disableOutputCap 与 outputBytesCap 不能同时使用')
    const cap =
      params.disableOutputCap === true || (kind === 'process' && params.outputBytesCap === null)
        ? Number.POSITIVE_INFINITY
        : integer(params.outputBytesCap, 'outputBytesCap', 1_000_000)
    const timeoutMs =
      params.disableTimeout === true || (kind === 'process' && params.timeoutMs === null)
        ? 0
        : integer(params.timeoutMs, 'timeoutMs', 60_000)
    if (
      params.env != null &&
      (typeof params.env !== 'object' ||
        Array.isArray(params.env) ||
        Object.values(params.env).some((value) => value !== null && typeof value !== 'string'))
    )
      throw new ProtocolError(-32602, 'env 必须是字符串或 null 的对象')
    if (kind === 'command') command = sandboxCommand(command as string[], cwd, params)
    if (tty) {
      const here = dirname(fileURLToPath(import.meta.url))
      const bridge = [
        resolve(here, '../../scripts/pty-bridge.py'),
        resolve(here, '../scripts/pty-bridge.py'),
      ].find(existsSync)
      if (!bridge) throw new ProtocolError(-32000, '缺少 PTY 运行时，不能降级为普通管道')
      command = [
        'python3',
        bridge,
        '--rows',
        String(size.rows),
        '--cols',
        String(size.cols),
        '--',
        ...(command as string[]),
      ]
    }
    const argv = command as string[]
    debugLog(`${kind}.spawn.start`, { id, cwd, tty, command: argv })
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: { ...commandEnv(params.env), ...(tty ? { TERM: 'xterm-256color' } : {}) },
      detached: !tty && process.platform !== 'win32',
      stdio: 'pipe',
    })
    const record: ProcessRecord = { child, tty, stdin, stopped: false }
    records.set(key, record)
    this.owned.set(peer.id, records)
    child.once('exit', () => this.terminate(record))
    child.stdin?.on('error', () => {}) // 对端退出后的 EPIPE 由下一次 write 的状态检查报告。
    if (!stdin) child.stdin?.end()
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const bytes = { stdout: 0, stderr: 0 }
    const capped = { stdout: false, stderr: false }
    const delta = (stream: 'stdout' | 'stderr', buffer: Buffer) => {
      const allowed = Math.min(buffer.length, Math.max(0, cap - bytes[stream]))
      const chunk = buffer.subarray(0, allowed)
      bytes[stream] += allowed
      capped[stream] ||= allowed < buffer.length
      if (!chunk.length) return
      if (streaming)
        peer.send({
          method: kind === 'command' ? 'command/exec/outputDelta' : 'process/outputDelta',
          params: { [field]: id, stream, deltaBase64: chunk.toString('base64'), capReached: false },
        })
      else output[stream].push(chunk)
    }
    if (tty) {
      let pending = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8')
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          try {
            const message = JSON.parse(line)
            delta('stdout', Buffer.from(message.delta, 'base64'))
          } catch {
            this.terminate(record)
          }
        }
      })
    } else child.stdout?.on('data', (chunk: Buffer) => delta('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => delta('stderr', chunk))
    const timeout = timeoutMs > 0 ? setTimeout(() => this.terminate(record), timeoutMs) : undefined
    let spawned = false
    return new Promise((resolveResult, reject) => {
      child.once('spawn', () => {
        spawned = true
        if (kind === 'process') resolveResult({})
      })
      child.once('error', (error) => {
        debugLog(`${kind}.spawn.error`, { id, error: error.message })
        reject(error)
      })
      child.once('close', (code, signal) => {
        if (timeout) clearTimeout(timeout)
        records.delete(key)
        if (!records.size) this.owned.delete(peer.id)
        debugLog(`${kind}.spawn.close`, { id, code, signal })
        for (const stream of ['stdout', 'stderr'] as const)
          if (streaming && capped[stream])
            peer.send({
              method: kind === 'command' ? 'command/exec/outputDelta' : 'process/outputDelta',
              params: { [field]: id, stream, deltaBase64: '', capReached: true },
            })
        const result = {
          exitCode: code ?? 1,
          stdout: streaming ? '' : Buffer.concat(output.stdout).toString('utf8'),
          stderr: streaming ? '' : Buffer.concat(output.stderr).toString('utf8'),
        }
        if (kind === 'command') resolveResult(result)
        else if (spawned)
          peer.send({
            method: 'process/exited',
            params: {
              processHandle: id,
              ...result,
              stdoutCapReached: capped.stdout,
              stderrCapReached: capped.stderr,
            },
          })
      })
    })
  }

  async followup(
    peer: RpcPeer,
    kind: 'command' | 'process',
    action: 'write' | 'resize' | 'kill',
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = requiredString(
      params[kind === 'command' ? 'processId' : 'processHandle'],
      '进程标识',
    )
    const record = this.owned.get(peer.id)?.get(`${kind}:${id}`)
    if (!record) throw new ProtocolError(-32602, '当前连接没有此活动进程')
    if (action === 'kill') {
      this.terminate(record)
      return {}
    }
    if (action === 'resize') {
      if (!record.tty) throw new ProtocolError(-32602, '普通管道进程不能调整 PTY 尺寸')
      const size = terminalSize(params.size)
      record.child.stdin?.write(`${JSON.stringify({ action: 'resize', ...size })}\n`)
      return {}
    }
    if (!record.stdin || record.child.stdin?.destroyed || record.child.stdin?.writableEnded)
      throw new ProtocolError(-32602, '进程没有可写 stdin')
    const data = params.deltaBase64 == null ? Buffer.alloc(0) : decodeBase64(params.deltaBase64)
    if (params.closeStdin != null && typeof params.closeStdin !== 'boolean')
      throw new ProtocolError(-32602, 'closeStdin 必须是布尔值')
    if (data.length) {
      await new Promise<void>((resolveWrite, reject) => {
        const payload = record.tty
          ? `${JSON.stringify({ action: 'input', data: data.toString('base64') })}\n`
          : data
        record.child.stdin!.write(payload, (error) => (error ? reject(error) : resolveWrite()))
      })
    }
    if (params.closeStdin === true) {
      record.stdin = false
      if (record.tty) record.child.stdin?.write('{"action":"eof"}\n')
      else record.child.stdin?.end()
    }
    return {}
  }

  private terminate(record: ProcessRecord): void {
    if (record.stopped) return
    record.stopped = true
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (!record.tty && process.platform !== 'win32' && record.child.pid)
          process.kill(-record.child.pid, signal)
        else record.child.kill(signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    kill('SIGTERM')
    // 进程的管道关闭不代表后台孙进程已退出；保留升级终止，关闭服务前也必须等回收。
    const reaped = new Promise<void>((resolveReaped) => {
      record.killTimer = setTimeout(() => {
        kill('SIGKILL')
        resolveReaped()
      }, 1_000)
    })
    this.reaping.add(reaped)
    void reaped.then(() => this.reaping.delete(reaped))
  }

  closePeer(peerId: string): void {
    for (const record of this.owned.get(peerId)?.values() ?? []) this.terminate(record)
  }

  async close(): Promise<void> {
    for (const peerId of this.owned.keys()) this.closePeer(peerId)
    await Promise.all(this.reaping)
  }
  get activeCount(): number {
    return [...this.owned.values()].reduce((sum, records) => sum + records.size, 0)
  }
}
