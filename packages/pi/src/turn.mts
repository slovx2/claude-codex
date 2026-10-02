import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, resolve } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { watchNativeSession } from './native-watch.mjs'
import { finishTool, messageItems, textContent, toolItem } from './projection.mjs'
import { planState } from './runtime.mjs'
import type { ActiveTurn, PiServer } from './server.mjs'
import type { PiThread } from './store.mjs'

export function onEvent(server: PiServer, thread: PiThread, event: any): void {
  if (event.type === 'adapter_idle') setImmediate(() => void server.releaseUnused().catch(() => {}))
  let active = server.active.get(thread.id)
  if (!active && event.type === 'agent_start') {
    const live = server.sessions.get(thread.id)
    if (live) {
      let resolve = () => {}
      const done = new Promise<void>((r) => {
        resolve = r
      })
      const turn = {
        id: `codex-harness-adapter:${randomUUID()}`,
        items: [],
        status: 'inProgress' as const,
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      }
      active = {
        thread,
        turn,
        live,
        stopped: false,
        native: true,
        tools: new Map(),
        done,
        resolve,
        pendingClientIds: [],
        notices: [],
      }
      server.active.set(thread.id, active)
      live.session.sessionManager.appendCustomEntry('codex-harness-adapter-turn', {
        id: turn.id,
        startedAt: turn.startedAt,
        source: 'pi',
      })
      server.store.saveTurn(thread.id, turn)
      server.notify(thread.id, 'turn/started', { turn })
      server.notify(thread.id, 'thread/status/changed', {
        status: { type: 'active', activeFlags: [] },
      })
      void followNativeTurn(server, active)
    }
  }
  if (event.type === 'session_info_changed') {
    const live = server.sessions.get(thread.id)
    thread.name = live?.session.sessionName ?? null
    server.store.saveThread(thread)
    server.notify(thread.id, 'thread/name/updated', { threadName: thread.name })
  }
  if (event.type === 'extension_error')
    server.notify(thread.id, 'warning', { message: String(event.error?.error ?? event.error) })
  if (event.type === 'subagent' && event.data?.id) {
    const data = event.data
    const running = server.background.get(thread.id) ?? new Set<string>()
    if (['completed', 'failed', 'resumed'].includes(event.kind)) {
      running.delete(data.id)
      setImmediate(() => void server.releaseUnused().catch(() => {}))
    } else if (['created', 'started', 'resuming'].includes(event.kind)) running.add(data.id)
    server.background.set(thread.id, running)
    const turns = active ? [active.turn] : server.store.turns(thread.id)
    for (const turn of turns) {
      const item =
        turn.items.find(
          (i) => i.type === 'collabAgentToolCall' && i.receiverThreadIds.includes(data.id),
        ) ??
        (active?.turn === turn
          ? turn.items.findLast(
              (i) => i.type === 'collabAgentToolCall' && !i.receiverThreadIds.length,
            )
          : undefined)
      if (!item) continue
      item.receiverThreadIds = [data.id]
      const status =
        event.kind === 'failed'
          ? 'errored'
          : ['completed', 'resumed'].includes(event.kind)
            ? data.error
              ? 'errored'
              : 'completed'
            : 'running'
      item.agentsStates = { [data.id]: { status, message: data.error ?? data.result ?? null } }
      server.store.saveTurn(thread.id, turn)
      server.notify(thread.id, 'item/completed', { turnId: turn.id, item })
    }
  }
  if (!active) return
  const { turn } = active
  const notify = (method: string, params: any) =>
    server.notify(thread.id, method, { turnId: turn.id, ...params })
  const put = (item: any, complete: boolean) => {
    const index = turn.items.findIndex((i) => i.id === item.id)
    if (index < 0) {
      turn.items.push(item)
      notify('item/started', {
        item: item.type === 'reasoning' ? { ...item, summary: [], content: [] } : item,
      })
      if (item.type === 'reasoning')
        notify('item/reasoning/summaryPartAdded', { itemId: item.id, summaryIndex: 0 })
    } else turn.items[index] = item
    if (complete) notify('item/completed', { item })
  }
  if (['message_start', 'message_update', 'message_end'].includes(event.type)) {
    for (const item of messageItems(event.message)) {
      if (item.type === 'userMessage') {
        const old = turn.items.find((i) => i.id === item.id)
        item.clientId = old?.clientId ?? active.pendingClientIds.shift() ?? null
      }
      put(item, event.type === 'message_end')
    }
    const delta = event.assistantMessageEvent
    if (delta?.type === 'text_delta')
      notify('item/agentMessage/delta', {
        itemId: `assistant:${event.message.timestamp}:${delta.contentIndex}`,
        delta: delta.delta,
      })
    if (delta?.type === 'thinking_delta')
      notify('item/reasoning/summaryTextDelta', {
        itemId: `assistant:${event.message.timestamp}:${delta.contentIndex}`,
        summaryIndex: 0,
        delta: delta.delta,
      })
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message
      if (message.stopReason === 'error')
        turn.error = {
          message: message.errorMessage ?? 'Pi 模型请求失败',
          codexErrorInfo: null,
          additionalDetails: null,
        }
      if (message.usage) {
        const u = message.usage
        const usage = {
          totalTokens:
            u.totalTokens ??
            (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
          inputTokens: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
          cachedInputTokens: u.cacheRead ?? 0,
          outputTokens: u.output ?? 0,
          reasoningOutputTokens: 0,
        }
        const previous = server.store.getMeta('usage', thread.id) ?? {
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        }
        const total = Object.fromEntries(
          Object.entries(usage).map(([k, v]) => [k, (previous[k] ?? 0) + v]),
        )
        server.store.setMeta('usage', thread.id, total)
        notify('thread/tokenUsage/updated', {
          tokenUsage: {
            total,
            last: usage,
            modelContextWindow: active.live?.session.model?.contextWindow ?? null,
          },
        })
      }
    }
  }
  if (event.type === 'tool_execution_start') {
    const item = toolItem(
      event.toolCallId,
      event.toolName,
      event.args,
      thread.cwd,
      thread.id,
      thread.dynamicTools,
    )
    let before: string | null | undefined
    if (event.toolName === 'write') {
      try {
        before = readFileSync(
          resolve(thread.cwd, event.args.path.replace(/^~(?=\/|$)/, homedir())),
          'utf8',
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') before = null
      }
    }
    active.tools.set(event.toolCallId, { item, args: event.args, before })
    put(item, false)
  }
  if (event.type === 'tool_execution_update') {
    const call = active.tools.get(event.toolCallId)
    if (call?.item.type === 'commandExecution') {
      const text = textContent(event.partialResult?.content),
        old = call.item.aggregatedOutput ?? ''
      call.item.aggregatedOutput = text
      notify('item/commandExecution/outputDelta', {
        itemId: event.toolCallId,
        delta: text.startsWith(old) ? text.slice(old.length) : text,
      })
    }
  }
  if (event.type === 'tool_execution_end') {
    const call = active.tools.get(event.toolCallId)
    if (call) {
      if (call.item.type === 'fileChange' && !event.isError && call.before !== undefined) {
        const path = call.args.path
        call.item.changes = [
          {
            path,
            kind: call.before === null ? { type: 'add' } : { type: 'update', move_path: null },
            // 协议 add 承载文件正文，只有 update 承载 unified diff。
            diff:
              call.before === null
                ? call.args.content
                : createTwoFilesPatch(path, path, call.before, call.args.content),
          },
        ]
        active.live?.session.sessionManager.appendCustomEntry('codex-harness-adapter-file-change', {
          id: event.toolCallId,
          changes: call.item.changes,
        })
      }
      finishTool(call.item, event.result, event.isError, call.args)
      put(call.item, true)
    }
    if (event.result?.details?.source === 'plan_mode_complete')
      put({ type: 'plan', id: `plan:${event.toolCallId}`, text: event.result.details.plan }, true)
  }
  if (event.type === 'compaction_end' && event.result) {
    const entry = active.live?.session.sessionManager
      .getBranch()
      .findLast((e) => e.type === 'compaction')
    if (entry) put({ type: 'contextCompaction', id: `compact:${entry.id}` }, true)
  }
  server.store.saveTurn(thread.id, turn)
}

export async function promptInput(input: any[]): Promise<{ text: string; images: any[] }> {
  if (!Array.isArray(input)) throw new Error('input 必须是数组')
  const parts: string[] = [],
    images: any[] = []
  for (const item of input) {
    if (item.type === 'text') parts.push(item.text)
    else if (item.type === 'localImage') {
      const data = await readFile(item.path)
      const extension = extname(item.path).toLowerCase()
      const mimeType =
        extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
      images.push({ type: 'image', mimeType, data: data.toString('base64') })
    } else if (item.type === 'image') {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(item.url ?? '')
      if (!match) throw new Error('Pi 图片输入需要 data URL 或本地文件')
      images.push({ type: 'image', mimeType: match[1], data: match[2] })
    } else if (item.type === 'skill') parts.push(`/skill:${item.name}`)
    else if (item.type === 'mention') parts.push(item.path)
    else throw new Error(`不支持输入类型: ${item.type}`)
  }
  return { text: parts.join('\n'), images }
}

export async function runTurn(server: PiServer, active: ActiveTurn, params: any): Promise<void> {
  const { thread, turn, peer } = active
  let unwatch = () => {},
    externalChange = false
  server.notify(thread.id, 'turn/started', { turn })
  server.notify(thread.id, 'thread/status/changed', { status: { type: 'active', activeFlags: [] } })
  try {
    const live = await server.load(thread, peer!, true)
    active.live = live
    if (active.stopped) return
    const session = live.session
    unwatch = watchNativeSession(session, () => {
      externalChange = true
      turn.error = {
        message: '原生会话在执行期间被其他实例修改，请重新加载后继续',
        codexErrorInfo: null,
        additionalDetails: null,
      }
      server.store.setMeta('queue', thread.id, { paused: true })
      session.clearQueue()
      void session.abort()
    })
    if (params.model) {
      const model = session.modelRuntime
        .getModels()
        .find((m) => `${m.provider}/${m.id}` === params.model)
      if (!model) throw new Error(`未知 Pi 模型: ${params.model}`)
      await session.setModel(model)
      thread.model = params.model
    }
    if (params.effort) session.setThinkingLevel(params.effort)
    session.sessionManager.appendCustomEntry('codex-harness-adapter-turn', {
      id: turn.id,
      startedAt: turn.startedAt,
      clientId: active.pendingClientIds[0] ?? null,
    })
    const { text, images } = await promptInput(params.input ?? [])
    if (!thread.preview) thread.preview = text.slice(0, 200)
    const state = planState(session)
    const mode = params.collaborationMode?.mode
    const implement =
      state.enabled &&
      state.latestPlan &&
      mode === 'default' &&
      (String(params.clientUserMessageId ?? params.clientMessageId ?? '').startsWith('plan:') ||
        text === `PLEASE IMPLEMENT THIS PLAN:\n${state.latestPlan}`)
    if (params.piCompact === true) {
      await session.compact()
    } else if (implement) {
      let started = false
      const remove = session.subscribe((e) => {
        if (e.type === 'agent_start') started = true
      })
      try {
        await session.prompt('/plan implement')
        await live.waitForExtensionInputs()
        if (!started && session.isIdle)
          throw new Error(active.notices?.at(-1) ?? 'Pi Plan 插件未启动实施回合')
        await session.waitForIdle()
      } finally {
        remove()
      }
    } else {
      if (mode === 'plan' && !state.enabled) await session.prompt('/plan start')
      if (mode === 'default' && state.enabled) await session.prompt('/plan exit')
      await session.prompt(text, { images })
    }
    await session.waitForIdle()
    thread.planMode = Boolean(planState(session).enabled)
    thread.name = session.sessionName ?? null
    thread.path = session.sessionFile ?? null
    thread.effort = session.thinkingLevel
  } catch (error) {
    if (process.env.PI_ADAPTER_DEBUG === '1' && error instanceof Error)
      process.stderr.write(`${error.stack}\n`)
    if (!active.stopped)
      turn.error = {
        message: error instanceof Error ? error.message : String(error),
        codexErrorInfo: null,
        additionalDetails: null,
      }
  } finally {
    unwatch()
    await finishTurn(server, active, externalChange)
  }
}

async function followNativeTurn(server: PiServer, active: ActiveTurn): Promise<void> {
  const session = active.live!.session
  let externalChange = false
  const unwatch = watchNativeSession(session, () => {
    externalChange = true
    active.turn.error = {
      message: '原生会话在执行期间被其他实例修改，请重新加载后继续',
      codexErrorInfo: null,
      additionalDetails: null,
    }
    server.store.setMeta('queue', active.thread.id, { paused: true })
    session.clearQueue()
    void session.abort()
  })
  try {
    // agent_start 的通知发生在 SDK 切换运行状态时，下一轮任务再等待完整 settled。
    await new Promise<void>((resolve) => setImmediate(resolve))
    await session.waitForIdle()
  } finally {
    unwatch()
    await finishTurn(server, active, externalChange)
  }
}

async function finishTurn(
  server: PiServer,
  active: ActiveTurn,
  externalChange: boolean,
): Promise<void> {
  const { thread, turn } = active
  const peer =
    (active.peer && server.peers.get(active.peer.id)) ||
    [...(server.subscriptions.get(thread.id) ?? [])].map((id) => server.peers.get(id)).find(Boolean)
  turn.status = active.stopped ? 'interrupted' : turn.error ? 'failed' : 'completed'
  turn.completedAt = Date.now()
  turn.durationMs = turn.completedAt - turn.startedAt
  if (!externalChange)
    active.live?.session.sessionManager.appendCustomEntry('codex-harness-adapter-turn-end', {
      id: turn.id,
      status: turn.status,
      error: turn.error,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    })
  thread.updatedAt = Math.floor(Date.now() / 1000)
  server.store.saveThread(thread)
  server.store.saveTurn(thread.id, turn)
  server.active.delete(thread.id)
  server.notify(thread.id, 'turn/completed', { turn })
  server.notify(thread.id, 'thread/status/changed', { status: { type: 'idle' } })
  server.notify(thread.id, 'thread/settings/updated', { threadSettings: server.settings(thread) })
  active.resolve()
  const queued = server.queue.list(thread.id)[0]
  if (peer && queued && !server.store.getMeta('queue', thread.id)?.paused && !turn.error) {
    // 队列提交使用同一幂等标识，重试不会产生第二次模型执行。
    try {
      server.start(peer, thread, {
        input: queued.input,
        clientUserMessageId: queued.clientUserMessageId,
        queuedSubmissionId: queued.id,
      })
      server.notify(thread.id, 'thread/queue/changed', {})
    } catch (error) {
      server.notify(thread.id, 'warning', { message: String(error) })
    }
  }
  await server.releaseUnused()
}
