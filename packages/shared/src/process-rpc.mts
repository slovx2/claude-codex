import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandEnv } from './command-env.mjs'
import { decodeBase64 } from './filesystem-rpc.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import type { RpcPeer } from './types.mjs'
import { debugLog } from './util.mjs'

// 语义对齐 Codex 0.157.1：core/src/exec.rs 的默认超时与排空时间、utils/pty 的
// 默认输出上限、app-server 的 process_exec_processor.rs / command_exec.rs。
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_OUTPUT_BYTES_CAP = 1_048_576
const IO_DRAIN_TIMEOUT_MS = 2_000
const EXEC_TIMEOUT_EXIT_CODE = 124
const DEFAULT_SIZE = { rows: 24, cols: 80 }

type Kind = 'command' | 'process'
type Stream = 'stdout' | 'stderr'

interface SpawnPlan {
  id: string
  key: string
  clientId: boolean
  command: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  tty: boolean
  stdin: boolean
  streaming: boolean
  size: { rows: number; cols: number }
  cap: number
  timeoutMs: number | null
}

function booleanParam(params: Record<string, unknown>, key: string): boolean {
  const value = params[key]
  if (value == null) return false
  if (typeof value !== 'boolean') throw new ProtocolError(-32602, `${key} 必须是布尔值`)
  return value
}

// usize 类型的字段：负数或非整数都是类型错误（原生由 serde 反序列化拒绝）。
function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ProtocolError(-32602, `${name} 必须是非负整数`)
  return value
}

function timeoutParam(value: unknown, method: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new ProtocolError(-32602, `${method} timeoutMs 必须是整数`)
  if (value < 0)
    throw new ProtocolError(-32602, `${method} timeoutMs must be non-negative, got ${value}`)
  return value
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new ProtocolError(-32602, 'command 必须是字符串数组')
  return value as string[]
}

function sizeParam(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 65535)
    throw new ProtocolError(-32602, `终端 ${name} 必须是 0 到 65535 之间的整数`)
  return value
}

function terminalSize(value: unknown, kind: Kind): { rows: number; cols: number } {
  const prefix = kind === 'command' ? 'command/exec' : 'process'
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError(-32602, `${prefix} size 必须是 {rows, cols} 对象`)
  const size = value as Record<string, unknown>
  const rows = sizeParam(size.rows, 'rows')
  const cols = sizeParam(size.cols, 'cols')
  if (!rows || !cols)
    throw new ProtocolError(-32602, `${prefix} size rows and cols must be greater than 0`)
  return { rows, cols }
}

function validateEnv(value: unknown): void {
  if (value == null) return
  if (typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError(-32602, 'env 必须是字符串或 null 的对象')
  for (const item of Object.values(value as Record<string, unknown>))
    if (item !== null && typeof item !== 'string')
      throw new ProtocolError(-32602, 'env 必须是字符串或 null 的对象')
}

function resolveCwd(kind: Kind, value: unknown): string {
  if (kind === 'process') {
    if (typeof value !== 'string') throw new ProtocolError(-32602, 'cwd 必须是字符串')
    if (!isAbsolute(value)) throw new ProtocolError(-32602, 'cwd 必须是绝对路径')
    return value
  }
  // command/exec 省略时为服务进程的 cwd，相对路径按它解析。
  if (value == null) return process.cwd()
  if (typeof value !== 'string') throw new ProtocolError(-32602, 'cwd 必须是字符串')
  return resolve(process.cwd(), value)
}

// 原生的 error_repr：客户端提供的标识按 JSON 字符串加引号，内部生成的 id 不加。
function duplicateMessage(kind: Kind, plan: { id: string; clientId: boolean }): string {
  return kind === 'process'
    ? `duplicate active process handle: ${JSON.stringify(plan.id)}`
    : `duplicate active command/exec process id: ${plan.clientId ? JSON.stringify(plan.id) : plan.id}`
}

function missingMessage(kind: Kind, id: string): string {
  return kind === 'process'
    ? `no active process for process handle ${JSON.stringify(id)}`
    : `no active command/exec for process id ${JSON.stringify(id)}`
}

function spawnFailureMessage(kind: Kind, detail: string): ProtocolError {
  return new ProtocolError(
    -32603,
    `failed to spawn ${kind === 'command' ? 'command' : 'process'}: ${detail}`,
  )
}

function ptyBridgePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  if (process.platform === 'win32') {
    let directory = here
    while (directory !== dirname(directory)) {
      const candidate = resolve(directory, 'bin/codex-harness-adapter.exe')
      if (existsSync(candidate)) return candidate
      directory = dirname(directory)
    }
    return ''
  }
  return (
    [
      resolve(here, '../../../../scripts/pty-bridge.py'),
      resolve(here, '../../../../../scripts/pty-bridge.py'),
      resolve(here, '../../../scripts/pty-bridge.py'),
    ].find(existsSync) ?? ''
  )
}

interface StreamCapture {
  pending: Buffer[]
  flush: NodeJS.Immediate | null
  buffered: Buffer[]
  bytes: number
  capReached: boolean
  done: boolean
}

interface ProcessRecord {
  kind: Kind
  // 客户端标识；command/exec 未提供 processId 时是内部生成、不对外暴露的编号。
  id: string
  key: string
  clientId: boolean
  peer: RpcPeer
  child: ChildProcess
  tty: boolean
  stdin: boolean
  stdinClosed: boolean
  streaming: boolean
  cap: number
  stdout: StreamCapture
  stderr: StreamCapture
  bridge: string
  bridgePid: number | null
  exit: { code: number | null; signal: NodeJS.Signals | null } | null
  spawned: boolean
  answered: boolean
  aborted: boolean
  terminated: boolean
  timedOut: boolean
  settled: boolean
  drainTimer: NodeJS.Timeout | null
  timeoutTimer: NodeJS.Timeout | null
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  finish: () => void
}

function capture(): StreamCapture {
  return { pending: [], flush: null, buffered: [], bytes: 0, capReached: false, done: false }
}

export class ProcessRpc {
  private readonly owned = new Map<string, Map<string, ProcessRecord>>()
  private readonly running = new Set<Promise<void>>()
  private generated = 0

  constructor(
    privateCommandPolicy: (
      command: string[],
      cwd: string,
      params: Record<string, unknown>,
    ) => string[],
  ) {
    this.commandPolicy = privateCommandPolicy
  }

  private readonly commandPolicy: (
    command: string[],
    cwd: string,
    params: Record<string, unknown>,
  ) => string[]

  async start(peer: RpcPeer, kind: Kind, params: Record<string, unknown>): Promise<unknown> {
    const plan = this.resolvePlan(kind, params)
    const records = this.owned.get(peer.id) ?? new Map<string, ProcessRecord>()
    if (records.has(plan.key)) throw new ProtocolError(-32600, duplicateMessage(kind, plan))
    const command =
      kind === 'command' ? this.commandPolicy(plan.command, plan.cwd, params) : plan.command
    const argv = plan.tty
      ? [
          ...(process.platform === 'win32'
            ? [this.ptyBridge(kind), 'pty-bridge']
            : ['python3', this.ptyBridge(kind)]),
          '--rows',
          String(plan.size.rows),
          '--cols',
          String(plan.size.cols),
          '--',
          ...command,
        ]
      : command
    debugLog(`${kind}.spawn.start`, {
      id: plan.id,
      cwd: plan.cwd,
      tty: plan.tty,
      command: argv,
    })
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: plan.cwd,
      env: plan.env,
      detached: !plan.tty && process.platform !== 'win32',
      stdio: plan.tty || plan.stdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    })
    let resolveResult: (value: unknown) => void = () => {}
    let rejectResult: (error: unknown) => void = () => {}
    const answer = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise
      rejectResult = rejectPromise
    })
    const record: ProcessRecord = {
      kind,
      id: plan.id,
      key: plan.key,
      clientId: plan.clientId,
      peer,
      child,
      tty: plan.tty,
      stdin: plan.stdin,
      stdinClosed: false,
      streaming: plan.streaming,
      cap: plan.cap,
      stdout: capture(),
      stderr: capture(),
      bridge: '',
      bridgePid: null,
      exit: null,
      spawned: false,
      answered: false,
      aborted: false,
      terminated: false,
      timedOut: false,
      settled: false,
      drainTimer: null,
      timeoutTimer: null,
      resolve: resolveResult,
      reject: rejectResult,
      finish: () => {},
    }
    const finished = new Promise<void>((resolveFinished) => {
      record.finish = () => {
        resolveFinished()
        this.running.delete(finished)
      }
    })
    this.running.add(finished)
    records.set(plan.key, record)
    this.owned.set(peer.id, records)

    child.once('error', (error) => {
      debugLog(`${kind}.spawn.error`, { id: plan.id, error: error.message })
      this.failSpawn(record, error.message)
    })
    child.once('spawn', () => {
      // tty 模式下先启动的是桥，等它回报 spawned 才算真正启动成功。
      if (plan.tty) return
      record.spawned = true
      if (kind === 'process') this.answerSpawn(record, {})
    })
    child.once('exit', (code, signal) => this.beginDrain(record, code, signal))
    child.once('close', (code, signal) => {
      record.exit ??= { code, signal }
      this.settleRecord(record)
    })
    // 对端退出后的 EPIPE 由下一次写入的状态检查报告。
    child.stdin?.on('error', () => {})
    if (plan.tty) {
      // 桥的 stderr 只写调试日志，不作为协议里的 stderr 输出。
      child.stderr?.on('data', (chunk: Buffer) =>
        debugLog(`${kind}.pty.stderr`, { id: plan.id, message: chunk.toString('utf8') }),
      )
      child.stdout?.on('data', (chunk: Buffer) => this.readBridgeLines(record, chunk))
    } else {
      child.stdout?.on('data', (chunk: Buffer) => this.queue(record, 'stdout', chunk))
      child.stderr?.on('data', (chunk: Buffer) => this.queue(record, 'stderr', chunk))
    }
    if (plan.timeoutMs != null)
      record.timeoutTimer = setTimeout(() => {
        // 超时标记后立即终止进程组；最终退出码固定为 124。
        record.timedOut = true
        this.terminate(record)
      }, plan.timeoutMs)
    return answer
  }

  private resolvePlan(kind: Kind, params: Record<string, unknown>): SpawnPlan {
    const method = kind === 'command' ? 'command/exec' : 'process/spawn'
    const tty = booleanParam(params, 'tty')
    const stdin = tty || booleanParam(params, 'streamStdin')
    const streaming = tty || booleanParam(params, 'streamStdoutStderr')
    const disableOutputCap = kind === 'command' && booleanParam(params, 'disableOutputCap')
    const disableTimeout = kind === 'command' && booleanParam(params, 'disableTimeout')
    const command = stringArray(params.command)
    if (!command.length) throw new ProtocolError(-32600, 'command must not be empty')
    let id: string | null = null
    let clientId = true
    if (kind === 'process') {
      const handle = params.processHandle
      if (typeof handle !== 'string') throw new ProtocolError(-32602, 'processHandle 必须是字符串')
      if (!handle) throw new ProtocolError(-32600, 'processHandle must not be empty')
      id = handle
    } else if (params.processId != null) {
      if (typeof params.processId !== 'string')
        throw new ProtocolError(-32602, 'processId 必须是字符串')
      id = params.processId
    }
    if (params.size != null && !tty)
      throw new ProtocolError(-32602, `${method} size requires tty: true`)
    if (disableOutputCap && params.outputBytesCap != null)
      throw new ProtocolError(
        -32602,
        'command/exec cannot set both outputBytesCap and disableOutputCap',
      )
    if (disableTimeout && params.timeoutMs != null)
      throw new ProtocolError(-32602, 'command/exec cannot set both timeoutMs and disableTimeout')
    validateEnv(params.env)
    let timeoutMs: number | null = DEFAULT_TIMEOUT_MS
    if (kind === 'command') {
      if (disableTimeout) timeoutMs = null
      else if (params.timeoutMs != null) timeoutMs = timeoutParam(params.timeoutMs, method)
    } else if (params.timeoutMs === null) timeoutMs = null
    else if (params.timeoutMs != null) timeoutMs = timeoutParam(params.timeoutMs, method)
    let cap = DEFAULT_OUTPUT_BYTES_CAP
    if (disableOutputCap) cap = Number.POSITIVE_INFINITY
    else if (kind === 'process' && params.outputBytesCap === null) cap = Number.POSITIVE_INFINITY
    else if (params.outputBytesCap != null)
      cap = nonNegativeInteger(params.outputBytesCap, 'outputBytesCap')
    const size = params.size == null ? { ...DEFAULT_SIZE } : terminalSize(params.size, kind)
    const cwd = resolveCwd(kind, params.cwd)
    if (kind === 'command' && id == null && (tty || stdin || streaming))
      throw new ProtocolError(
        -32600,
        'command/exec tty or streaming requires a client-supplied processId',
      )
    if (id == null) {
      clientId = false
      id = String(++this.generated)
    }
    return {
      id,
      key: kind === 'command' ? `command:${clientId ? id : `#${id}`}` : `process:${id}`,
      clientId,
      command,
      cwd,
      env: commandEnv(params.env),
      tty,
      stdin,
      streaming,
      size,
      cap,
      timeoutMs,
    }
  }

  private ptyBridge(kind: Kind): string {
    const bridge = ptyBridgePath()
    if (!bridge) throw spawnFailureMessage(kind, 'PTY 桥缺失，请先运行 npm run build')
    return bridge
  }

  async followup(
    peer: RpcPeer,
    kind: Kind,
    action: 'write' | 'resize' | 'kill',
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const method = kind === 'command' ? 'command/exec/write' : 'process/writeStdin'
    const field = kind === 'command' ? 'processId' : 'processHandle'
    const id = params[field]
    if (typeof id !== 'string') throw new ProtocolError(-32602, `${field} 必须是字符串`)
    if (action === 'write') return this.writeStdin(peer, kind, method, id, params)
    if (action === 'resize') {
      const size = terminalSize(params.size, kind)
      const record = this.record(peer, kind, id)
      if (!record) throw new ProtocolError(-32600, missingMessage(kind, id))
      if (!record.tty)
        throw new ProtocolError(-32600, 'failed to resize PTY: process is not attached to a PTY')
      this.writeLine(record, { action: 'resize', rows: size.rows, cols: size.cols })
      return {}
    }
    const record = this.record(peer, kind, id)
    if (!record) throw new ProtocolError(-32600, missingMessage(kind, id))
    this.terminate(record)
    return {}
  }

  private async writeStdin(
    peer: RpcPeer,
    kind: Kind,
    method: string,
    id: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const closeStdin = booleanParam(params, 'closeStdin')
    if (params.deltaBase64 == null && !closeStdin)
      throw new ProtocolError(-32602, `${method} requires deltaBase64 or closeStdin`)
    const data = params.deltaBase64 == null ? Buffer.alloc(0) : decodeBase64(params.deltaBase64)
    const record = this.record(peer, kind, id)
    if (!record) throw new ProtocolError(-32600, missingMessage(kind, id))
    if (!record.stdin)
      throw new ProtocolError(
        -32600,
        kind === 'command'
          ? 'stdin streaming is not enabled for this command/exec'
          : 'stdin streaming is not enabled for this process',
      )
    if (data.length) {
      if (record.stdinClosed) throw new ProtocolError(-32600, 'stdin is already closed')
      if (record.tty) this.writeLine(record, { action: 'input', data: data.toString('base64') })
      else await this.writePipe(record, data)
    }
    if (closeStdin) {
      record.stdinClosed = true
      if (record.tty) this.writeLine(record, { action: 'eof' })
      else record.child.stdin?.end()
    }
    return {}
  }

  // 收到的数据先排队，在下一个事件循环统一成一片发出（允许超出一个读取块）。
  private queue(record: ProcessRecord, stream: Stream, chunk: Buffer): void {
    const state = record[stream]
    if (state.done) return
    state.pending.push(chunk)
    state.flush ??= setImmediate(() => this.flushStream(record, stream))
  }

  private flushStream(record: ProcessRecord, stream: Stream): void {
    const state = record[stream]
    state.flush = null
    if (state.done || !state.pending.length) return
    const merged = Buffer.concat(state.pending)
    state.pending = []
    const allowed = Number.isFinite(record.cap)
      ? Math.max(0, Math.min(merged.length, record.cap - state.bytes))
      : merged.length
    const chunk = merged.subarray(0, allowed)
    state.bytes += chunk.length
    state.capReached = Number.isFinite(record.cap) && state.bytes === record.cap
    if (record.streaming) this.sendDelta(record, stream, chunk, state.capReached)
    else state.buffered.push(chunk)
    if (state.capReached) {
      // 触达上限后该流不再读取、也不再发送。
      state.done = true
      state.pending = []
      const readable = stream === 'stdout' ? record.child.stdout : record.child.stderr
      readable?.pause()
    }
  }

  private flushStreams(record: ProcessRecord): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const state = record[stream]
      if (state.flush) {
        clearImmediate(state.flush)
        state.flush = null
      }
      if (!state.done && state.pending.length) this.flushStream(record, stream)
    }
  }

  private sendDelta(
    record: ProcessRecord,
    stream: Stream,
    chunk: Buffer,
    capReached: boolean,
  ): void {
    // 内部生成的 command/exec id 不对外暴露，与原生一样不发通知。
    if (!record.clientId) return
    record.peer.send({
      method: record.kind === 'command' ? 'command/exec/outputDelta' : 'process/outputDelta',
      params: {
        [record.kind === 'command' ? 'processId' : 'processHandle']: record.id,
        stream,
        deltaBase64: chunk.toString('base64'),
        capReached,
      },
    })
  }

  private readBridgeLines(record: ProcessRecord, chunk: Buffer): void {
    record.bridge += chunk.toString('utf8')
    const lines = record.bridge.split('\n')
    record.bridge = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch (error) {
        debugLog('process.pty.line', {
          id: record.id,
          line,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      this.handleBridgeMessage(record, message)
    }
  }

  private handleBridgeMessage(record: ProcessRecord, message: Record<string, unknown>): void {
    if (message.event === 'spawned' && typeof message.pid === 'number') {
      // 桥的子进程 setsid 后自成进程组，握手拿到的 pid 就是进程组号。
      record.bridgePid = message.pid
      record.spawned = true
      if (record.kind === 'process') this.answerSpawn(record, {})
      return
    }
    if (message.event === 'spawnError') {
      this.failSpawn(
        record,
        typeof message.message === 'string' ? message.message : 'PTY 桥启动失败',
      )
      return
    }
    if (message.stream === 'stdout' && typeof message.delta === 'string')
      this.queue(record, 'stdout', Buffer.from(message.delta, 'base64'))
    else debugLog('process.pty.line', { id: record.id, message })
  }
  private answerSpawn(record: ProcessRecord, value: unknown): void {
    if (record.answered) return
    record.answered = true
    record.resolve(value)
  }

  private failSpawn(record: ProcessRecord, detail: string): void {
    if (record.aborted || record.settled) return
    record.aborted = true
    if (record.child.pid) record.child.kill('SIGKILL')
    this.abandon(record)
    debugLog(`${record.kind}.spawn.failed`, { id: record.id, detail })
    record.reject(spawnFailureMessage(record.kind, detail))
  }

  // 子进程退出后最多再等 2 秒排空输出，以 stdio 关闭（close）为准。
  private beginDrain(
    record: ProcessRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    record.exit ??= { code, signal }
    if (record.settled || record.drainTimer) return
    record.drainTimer = setTimeout(() => this.settleRecord(record), IO_DRAIN_TIMEOUT_MS)
  }

  private settleRecord(record: ProcessRecord): void {
    if (record.settled || record.aborted) return
    this.abandon(record)
    if (!record.spawned) {
      // 没等到启动成功就退出了（例如桥没有完成握手），按启动失败处理。
      const exit = record.exit
      record.reject(
        spawnFailureMessage(
          record.kind,
          `进程在启动阶段退出（exit ${exit?.code ?? exit?.signal ?? 'unknown'}）`,
        ),
      )
      return
    }
    this.flushStreams(record)
    // 退出后再对进程组发一次 SIGKILL，回收残留的孙进程。
    this.killGroup(record)
    const exitCode = this.exitCode(record)
    const stdout = record.streaming ? '' : Buffer.concat(record.stdout.buffered).toString('utf8')
    const stderr = record.streaming ? '' : Buffer.concat(record.stderr.buffered).toString('utf8')
    debugLog(`${record.kind}.exit`, { id: record.id, exitCode, stdout, stderr })
    if (record.kind === 'process')
      record.peer.send({
        method: 'process/exited',
        params: {
          processHandle: record.id,
          exitCode,
          stdout,
          stderr,
          stdoutCapReached: record.stdout.capReached,
          stderrCapReached: record.stderr.capReached,
        },
      })
    else {
      record.answered = true
      record.resolve({ exitCode, stdout, stderr })
    }
  }

  private abandon(record: ProcessRecord): void {
    if (record.settled) return
    record.settled = true
    if (record.drainTimer) clearTimeout(record.drainTimer)
    if (record.timeoutTimer) clearTimeout(record.timeoutTimer)
    record.drainTimer = null
    record.timeoutTimer = null
    this.forget(record)
    record.finish()
  }

  private exitCode(record: ProcessRecord): number {
    if (record.timedOut) return EXEC_TIMEOUT_EXIT_CODE
    const code = record.exit?.code ?? null
    if (code != null) return code
    const signal = record.exit?.signal ?? null
    // tty 模式下退出码来自桥；被信号终止时桥返回 1，与 portable-pty 一致。
    if (record.tty || !signal) return 1
    return 128 + (osConstants.signals[signal] ?? 0)
  }

  // 终止（kill、terminate、断开连接、超时）立即对进程组发 SIGKILL，不先 SIGTERM。
  private terminate(record: ProcessRecord): void {
    if (record.terminated) return
    record.terminated = true
    this.killGroup(record)
  }

  private killGroup(record: ProcessRecord): void {
    if (record.tty) this.writeLine(record, { action: 'kill' })
    const pid = record.tty ? record.bridgePid : (record.child.pid ?? null)
    if (pid == null) return
    try {
      if (process.platform === 'win32') {
        if (!record.tty) {
          const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
          })
          killer.on('error', (error) => debugLog('process.kill.error', { error: error.message }))
        }
      } else process.kill(-pid, 'SIGKILL')
    } catch (error) {
      // 与原生一致：进程组已经消失（ESRCH）等失败不影响收尾。
      debugLog('process.kill.error', {
        id: record.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private writeLine(record: ProcessRecord, message: Record<string, unknown>): void {
    const stdin = record.child.stdin
    if (!stdin || stdin.destroyed || stdin.writableEnded) return
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  private writePipe(record: ProcessRecord, data: Buffer): Promise<void> {
    return new Promise<void>((resolveWrite, rejectWrite) => {
      const stdin = record.child.stdin
      if (!stdin || stdin.destroyed || stdin.writableEnded) {
        rejectWrite(new ProtocolError(-32600, 'stdin is already closed'))
        return
      }
      stdin.write(data, (error) =>
        error ? rejectWrite(new ProtocolError(-32600, 'stdin is already closed')) : resolveWrite(),
      )
    })
  }

  private record(peer: RpcPeer, kind: Kind, id: string): ProcessRecord | null {
    return this.owned.get(peer.id)?.get(`${kind}:${id}`) ?? null
  }

  private forget(record: ProcessRecord): void {
    const records = this.owned.get(record.peer.id)
    if (!records) return
    records.delete(record.key)
    if (!records.size) this.owned.delete(record.peer.id)
  }

  closePeer(peerId: string): void {
    for (const record of this.owned.get(peerId)?.values() ?? []) this.terminate(record)
  }

  async close(): Promise<void> {
    for (const peerId of [...this.owned.keys()]) this.closePeer(peerId)
    await Promise.all([...this.running])
  }

  get activeCount(): number {
    return [...this.owned.values()].reduce((sum, records) => sum + records.size, 0)
  }
}
