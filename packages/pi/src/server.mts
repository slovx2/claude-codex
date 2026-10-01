import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { FuzzyFileSearch, FuzzySearchSessions } from '../../shared/src/fuzzy-session.mjs'
import { ProcessRpc } from '../../shared/src/process-rpc.mjs'
import { ProjectStore } from '../../shared/src/project-store.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { QueueStore } from '../../shared/src/queue-store.mjs'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { NativeFiles, nativeBranch, sessionIndexDirectories } from './native-files.mjs'
import { discoverSessions, projectHistory } from './projection.mjs'
import { dispatch } from './protocol.mjs'
import { type LiveSession, openSession, planState } from './runtime.mjs'
import { PiStore, type PiThread, type PiTurn } from './store.mjs'
import { onEvent, runTurn } from './turn.mjs'
import { createUi } from './ui.mjs'

export interface ActiveTurn {
  thread: PiThread
  turn: PiTurn
  peer?: RpcPeer
  live?: LiveSession
  stopped: boolean
  tools: Map<string, { item: any; args: any; before?: string | null | undefined }>
  done: Promise<void>
  resolve: () => void
  pendingClientIds: string[]
  native?: boolean
  notices?: string[]
}
export class PiServer {
  readonly store: PiStore
  readonly projects: ProjectStore
  readonly queue: QueueStore
  readonly files = new FilesystemRpc()
  readonly processes = new ProcessRpc((command) => command)
  readonly search = new FuzzyFileSearch()
  readonly searches = new FuzzySearchSessions((peer, message) => peer.send(message))
  readonly peers = new Map<string, RpcPeer>()
  readonly subscriptions = new Map<string, Set<string>>()
  readonly sessions = new Map<string, LiveSession>()
  readonly active = new Map<string, ActiveTurn>()
  readonly nativeFiles = new NativeFiles()
  readonly background = new Map<string, Set<string>>()
  private readonly loading = new Map<string, Promise<LiveSession>>()
  private readonly releasing = new Map<string, Promise<void>>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly pending = new Map<
    string,
    {
      peer: string
      threadId: string
      resolve: (v: any) => void
      reject: (e: Error) => void
      clear: () => void
    }
  >()
  private indexing: Promise<void> | null = null
  private closing = false
  private readonly indexed = new Map<string, any[]>()
  constructor(home: string) {
    this.store = new PiStore(home)
    this.projects = new ProjectStore(this.store.db)
    this.queue = new QueueStore(this.store.db)
  }

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    this.peers.set(peer.id, peer)
    if (!('method' in message)) {
      const pending = this.pending.get(String(message.id))
      if (pending?.peer === peer.id) {
        this.pending.delete(String(message.id))
        pending.clear()
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        this.notify(pending.threadId, 'serverRequest/resolved', { requestId: message.id })
      }
      return
    }
    if (!('id' in message)) return
    try {
      const params =
        message.params && typeof message.params === 'object' ? (message.params as any) : {}
      const work = () => dispatch(this, peer, message.method, params)
      const threadId = typeof params.threadId === 'string' ? params.threadId : null
      const result = threadId ? await this.serial(threadId, work) : await work()
      peer.send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      peer.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: error instanceof ProtocolError ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      })
    } finally {
      void this.releaseUnused().catch(() => {})
    }
  }
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.locks.set(id, next)
    try {
      return await next
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id)
    }
  }
  subscribe(peer: RpcPeer, id: string): void {
    const ids = this.subscriptions.get(id) ?? new Set<string>()
    ids.add(peer.id)
    this.subscriptions.set(id, ids)
  }
  notify(threadId: string | null, method: string, params: any): void {
    if (method === 'item/started') params = { startedAtMs: Date.now(), ...params }
    if (method === 'item/completed')
      params = { startedAtMs: null, completedAtMs: Date.now(), ...params }
    for (const peer of this.peers.values())
      if (threadId === null || this.subscriptions.get(threadId)?.has(peer.id))
        peer.send({ method, params: threadId ? { threadId, ...params } : params })
  }
  call(
    peer: RpcPeer | undefined,
    threadId: string,
    method: string,
    params: any,
    signal?: AbortSignal,
  ): Promise<any> {
    if (signal?.aborted) return Promise.reject(new Error('已取消'))
    peer =
      (peer && this.peers.get(peer.id)) ??
      [...(this.subscriptions.get(threadId) ?? [])].map((id) => this.peers.get(id)).find(Boolean)
    if (!peer) return Promise.reject(new Error('没有可处理交互的已连接客户端'))
    const target = peer
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', cancel)
        this.notify(threadId, 'serverRequest/resolved', { requestId: id })
        reject(new Error('已取消'))
      }
      this.pending.set(id, {
        peer: target.id,
        threadId,
        resolve,
        reject,
        clear: () => signal?.removeEventListener('abort', cancel),
      })
      signal?.addEventListener('abort', cancel, { once: true })
      target.send({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          threadId,
          turnId: this.active.get(threadId)?.turn.id ?? '',
          itemId: id,
          ...params,
        },
      })
    })
  }
  async index(cwd?: string): Promise<void> {
    if (this.indexing) return this.indexing
    this.indexing = (async () => {
      const rows = this.store.threads()
      const byPath = new Map(rows.map((t) => [t.path, t]))
      const byId = new Map(rows.map((t) => [t.id, t]))
      for (const directory of sessionIndexDirectories([
        cwd ?? process.cwd(),
        ...rows.map((t) => t.cwd),
      ]))
        for (const { thread, entries } of await discoverSessions(directory, this.nativeFiles)) {
          const old = byPath.get(thread.path) ?? byId.get(thread.id)
          if (old && this.active.has(old.id)) continue
          if (old && thread.path && this.indexed.get(thread.path) === entries) continue
          if (old) {
            thread.id = old.id
            thread.dynamicTools = old.dynamicTools
            thread.forkedFromId = old.forkedFromId
          }
          this.store.saveThread(thread)
          this.store.replaceTurns(thread.id, projectHistory(nativeBranch(entries), thread))
          if (thread.path) this.indexed.set(thread.path, entries)
        }
    })()
    try {
      await this.indexing
    } finally {
      this.indexing = null
    }
  }
  async load(thread: PiThread, peer: RpcPeer, refresh = false): Promise<LiveSession> {
    const pending = this.loading.get(thread.id)
    if (pending) return this.synchronize(thread, await pending)
    const loading = (async () => {
      await this.releasing.get(thread.id)
      return this.open(thread, peer, refresh)
    })()
    this.loading.set(thread.id, loading)
    try {
      return await loading
    } finally {
      this.loading.delete(thread.id)
    }
  }
  private async open(thread: PiThread, peer: RpcPeer, refresh: boolean): Promise<LiveSession> {
    const cached = this.sessions.get(thread.id)
    if (
      !thread.ephemeral &&
      thread.path &&
      !existsSync(thread.path) &&
      this.store.turns(thread.id).some((t) => t.items.length)
    )
      throw new ProtocolError(-32009, 'Pi 原生会话文件已移除，无法继续恢复')
    if (cached && (!refresh || !thread.path || !existsSync(thread.path)))
      return this.synchronize(thread, cached)
    if (cached && thread.path) {
      const disk = this.nativeFiles.read(thread.path).slice(1)
      if (JSON.stringify(disk) === JSON.stringify(cached.session.sessionManager.getEntries()))
        return this.synchronize(thread, cached)
    }
    if (cached) {
      await cached.dispose()
      this.sessions.delete(thread.id)
    }
    const reverse = (method: string, params: any, signal?: AbortSignal) =>
      this.call(this.active.get(thread.id)?.peer ?? peer, thread.id, method, params, signal)
    const live = await openSession(thread, {
      ui: createUi(reverse, (method, params) => {
        if (method === 'warning') this.active.get(thread.id)?.notices?.push(params.message)
        this.notify(thread.id, method, params)
      }),
      emit: (event) => onEvent(this, thread, event),
      tool: (tool, args, id, signal) =>
        reverse(
          'item/tool/call',
          { tool: tool.name, namespace: tool.namespace, arguments: args, callId: id, itemId: id },
          signal,
        ),
    })
    this.sessions.set(thread.id, live)
    return this.synchronize(thread, live)
  }
  private synchronize(thread: PiThread, live: LiveSession): LiveSession {
    thread.path = live.session.sessionFile ?? null
    thread.name = live.session.sessionName ?? null
    thread.model = live.session.model
      ? `${live.session.model.provider}/${live.session.model.id}`
      : null
    thread.effort = live.session.thinkingLevel
    thread.planMode = Boolean(planState(live.session).enabled)
    this.store.saveThread(thread)
    if (
      !this.active.has(thread.id) &&
      live.session.sessionManager.getEntries().some((e) => e.type === 'message')
    )
      this.store.replaceTurns(
        thread.id,
        projectHistory(live.session.sessionManager.getBranch(), thread),
      )
    return live
  }
  envelope(thread: PiThread, includeTurns = true, byId?: Map<string, PiThread>): any {
    const ancestors = thread.parentThreadId ? this.ancestors(thread, byId) : []
    return {
      id: thread.id,
      sessionId: thread.id,
      forkedFromId: thread.forkedFromId,
      preview: thread.preview,
      name: thread.name,
      modelProvider: thread.model?.split('/')[0] ?? 'pi',
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: this.active.has(thread.id) ? { type: 'active', activeFlags: [] } : { type: 'idle' },
      path: thread.path,
      cwd: thread.cwd,
      cliVersion: '0.99.1',
      source: thread.parentThreadId
        ? {
            subAgent: {
              thread_spawn: { parent_thread_id: thread.parentThreadId, depth: ancestors.length },
            },
          }
        : 'appServer',
      parentThreadId: thread.parentThreadId ?? null,
      ephemeral: thread.ephemeral,
      gitInfo: null,
      agentNickname: null,
      agentRole: null,
      turns: includeTurns ? this.store.turns(thread.id) : [],
      projectId: this.projects.projectId(thread.id),
      ...this.store.getMeta('thread', thread.id),
    }
  }
  ancestors(
    thread: PiThread,
    byId = new Map(this.store.threads().map((row) => [row.id, row])),
  ): string[] {
    const ancestors: string[] = []
    const seen = new Set([thread.id])
    let parent = thread.parentThreadId
    while (parent && !seen.has(parent)) {
      ancestors.push(parent)
      seen.add(parent)
      parent = byId.get(parent)?.parentThreadId
    }
    return ancestors
  }
  settings(thread: PiThread): any {
    return {
      thread: this.envelope(thread),
      model: thread.model ?? '',
      modelProvider: thread.model?.split('/')[0] ?? 'pi',
      cwd: thread.cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'dangerFullAccess' },
      sandboxPolicy: { type: 'dangerFullAccess' },
      reasoningEffort: thread.effort,
      collaborationMode: {
        mode: thread.planMode ? 'plan' : 'default',
        settings: {
          model: thread.model ?? '',
          reasoning_effort: thread.effort,
          developer_instructions: null,
        },
      },
    }
  }
  start(peer: RpcPeer, thread: PiThread, params: any): PiTurn {
    const clientId = params.clientUserMessageId ?? params.clientMessageId ?? null
    const input = {
      input: params.input,
      collaborationMode: params.collaborationMode,
      model: params.model,
    }
    const existing = clientId ? this.store.submitted(thread.id, clientId, input) : null
    if (existing) return existing
    if (params.outputSchema != null) throw new ProtocolError(-32602, 'Pi 首期不支持严格结构化输出')
    if (
      this.active.has(thread.id) ||
      this.sessions.get(thread.id)?.session.isIdle === false ||
      this.sessions.get(thread.id)?.hasPendingInputs()
    )
      throw new ProtocolError(-32009, '会话已有活动回合')
    const turn: PiTurn = {
      id: `tyrs:${randomUUID()}`,
      items: [],
      status: 'inProgress',
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      durationMs: null,
    }
    let resolve = () => {}
    const done = new Promise<void>((r) => {
      resolve = r
    })
    const active: ActiveTurn = {
      thread,
      turn,
      peer,
      stopped: false,
      tools: new Map(),
      done,
      resolve,
      pendingClientIds: clientId ? [clientId] : [],
      notices: [],
    }
    this.store.admit(
      thread.id,
      clientId,
      input,
      turn,
      params.queuedSubmissionId
        ? () => this.queue.consume(thread.id, params.queuedSubmissionId, clientId, params.input)
        : undefined,
    )
    this.active.set(thread.id, active)
    this.subscribe(peer, thread.id)
    setImmediate(() => void runTurn(this, active, params))
    return turn
  }
  async interrupt(id: string): Promise<void> {
    const active = this.active.get(id)
    this.store.setMeta('queue', id, { paused: true })
    if (active) active.stopped = true
    for (const [key, p] of this.pending)
      if (p.threadId === id) {
        p.clear()
        p.reject(new Error('回合已停止'))
        this.pending.delete(key)
        this.notify(id, 'serverRequest/resolved', { requestId: key })
      }
    active?.live?.session.clearQueue()
    await active?.live?.session.abort()
    await active?.done
    const live = this.sessions.get(id)
    if (live) {
      await live.dispose()
      this.sessions.delete(id)
      this.background.delete(id)
    }
  }
  closePeer(peer: RpcPeer): void {
    this.peers.delete(peer.id)
    this.files.closePeer(peer.id)
    this.processes.closePeer(peer.id)
    for (const ids of this.subscriptions.values()) ids.delete(peer.id)
    for (const [id, p] of this.pending)
      if (p.peer === peer.id) {
        p.clear()
        p.reject(new Error('客户端已断开'))
        this.pending.delete(id)
        this.notify(p.threadId, 'serverRequest/resolved', { requestId: id })
      }
    void this.releaseUnused().catch(() => {})
  }
  async releaseUnused(): Promise<void> {
    if (this.closing) return
    for (const [id, live] of this.sessions) {
      if (
        this.subscriptions.get(id)?.size ||
        this.active.has(id) ||
        !live.session.isIdle ||
        live.hasPendingInputs() ||
        this.background.get(id)?.size ||
        this.loading.has(id) ||
        this.releasing.has(id) ||
        this.locks.has(id)
      )
        continue
      const releasing = live.dispose().finally(() => {
        if (this.sessions.get(id) === live) this.sessions.delete(id)
        this.releasing.delete(id)
        this.background.delete(id)
      })
      this.releasing.set(id, releasing)
      await releasing
    }
    await Promise.all(this.releasing.values())
  }
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled(this.loading.values())
    await Promise.allSettled(this.releasing.values())
    for (const id of this.active.keys()) await this.interrupt(id)
    for (const live of this.sessions.values()) await live.dispose()
    this.sessions.clear()
    this.files.close()
    await this.processes.close()
    this.store.close()
  }
}
