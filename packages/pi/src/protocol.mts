import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import {
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { gitDiffToRemote } from '../../shared/src/git-diff-remote.mjs'
import { projectRequest } from '../../shared/src/project-rpc.mjs'
import { ProtocolError, pageRecords, requiredString } from '../../shared/src/protocol-contract.mjs'
import { codexUserAgent, platformFamily, platformOs } from '../../shared/src/runtime-version.mjs'
import { PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { clientTools } from './dynamic-tools.mjs'
import { metadataRequest } from './metadata.mjs'
import { sessionDirectory } from './native-files.mjs'
import { projectHistory, textContent } from './projection.mjs'
import { planState } from './runtime.mjs'
import type { PiServer } from './server.mjs'
import { skillsAt, writeSkill } from './skills.mjs'
import type { PiThread } from './store.mjs'
import { promptInput } from './turn.mjs'
import { runtimeInfo, versions } from './versions.mjs'

export async function dispatch(s: PiServer, peer: RpcPeer, method: string, p: any): Promise<any> {
  if (method.startsWith('fs/')) return s.files.call(peer, method, p)
  if (method === 'command/exec' || method === 'process/spawn')
    return s.processes.start(peer, method === 'command/exec' ? 'command' : 'process', p)
  if (
    method.startsWith('command/exec/') ||
    ['process/writeStdin', 'process/resizePty', 'process/kill'].includes(method)
  )
    return s.processes.followup(
      peer,
      method.startsWith('command/') ? 'command' : 'process',
      /write|writeStdin/.test(method) ? 'write' : /resize/.test(method) ? 'resize' : 'kill',
      p,
    )
  if (method.startsWith('project/'))
    return projectRequest(
      s.projects,
      method,
      p,
      (projectId, changeType) => s.notify(null, 'project/changed', { projectId, changeType }),
      (threadId, projectId) => s.notify(threadId, 'thread/project/updated', { projectId }),
    )
  if (
    method.startsWith('thread/queue/') ||
    method.startsWith('threadSection/') ||
    method.startsWith('thread/attachment/') ||
    ['thread/section/move', 'thread/metadata/update'].includes(method)
  )
    return metadataRequest(s, peer, method, p)
  switch (method) {
    case 'initialize':
      return {
        userAgent: codexUserAgent(
          typeof p.clientInfo?.name === 'string' ? p.clientInfo.name : 'codex-app',
          typeof p.clientInfo?.version === 'string' ? p.clientInfo.version : 'unknown',
          versions.protocol,
          'codex-harness-adapter-pi',
        ),
        codexHome: process.env.CODEX_HOME ?? getAgentDir(),
        platformFamily: platformFamily(),
        platformOs: platformOs(),
      }
    case 'runtime/info':
      return runtimeInfo()
    case 'server/diagnostics':
      return {
        engine: 'pi',
        activeSessions: s.active.size,
        loadedSessions: s.sessions.size,
        subagentScope: 'builtin-and-global',
      }
    case 'currentTime/read':
      return { currentTime: new Date().toISOString() }
    case 'account/read':
      return { account: null, requiresOpenaiAuth: false }
    case 'getAuthStatus':
      return { authMethod: null, authToken: null, requiresOpenaiAuth: false }
    case 'account/rateLimits/read':
      return { rateLimits: null, rateLimitsByLimitId: null }
    case 'configRequirements/read':
      return { requirements: null }
    case 'modelProvider/capabilities/read':
      return { namespaceTools: true, imageGeneration: false, webSearch: false }
    case 'app/list':
    case 'hooks/list':
    case 'experimentalFeature/list':
      return { data: [], nextCursor: null }
    case 'plugin/list':
      return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
    case 'plugin/share/list':
      return { data: [] }
    case 'externalAgentConfig/detect':
      return { items: [] }
    case 'permissionProfile/list':
      return { data: [], nextCursor: null }
    case 'model/list': {
      const runtime = await ModelRuntime.create({
        authPath: join(getAgentDir(), 'auth.json'),
        modelsPath: join(getAgentDir(), 'models.json'),
      })
      const models = await runtime.getAvailable()
      const settings = SettingsManager.create(p.cwd ?? process.cwd(), getAgentDir())
      return {
        data: models.map((m) => ({
          id: `${m.provider}/${m.id}`,
          model: `${m.provider}/${m.id}`,
          displayName: m.name,
          description: m.provider,
          hidden: false,
          modelSpecialty: null,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault:
            settings.getDefaultProvider() === m.provider && settings.getDefaultModel() === m.id,
          supportedReasoningEfforts: getSupportedThinkingLevels(m).map((reasoningEffort) => ({
            reasoningEffort,
            description: reasoningEffort,
          })),
          defaultReasoningEffort: m.reasoning ? 'medium' : 'off',
          inputModalities: m.input,
          supportsPersonality: false,
          upgrade: null,
          availabilityNux: null,
          upgradeInfo: null,
        })),
        nextCursor: null,
      }
    }
    case 'config/read': {
      const settings = SettingsManager.create(p.cwd ?? process.cwd(), getAgentDir())
      return {
        config: {
          model: settings.getDefaultModel()
            ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}`
            : null,
          model_provider: 'pi',
          model_reasoning_effort: settings.getDefaultThinkingLevel() ?? null,
          approval_policy: 'never',
          sandbox_mode: 'danger-full-access',
          features: {},
          model_providers: { pi: { name: 'Pi', requires_openai_auth: false } },
        },
        origins: {},
        layers: [],
      }
    }
    case 'config/value/write':
    case 'config/batchWrite': {
      const settings = SettingsManager.create(p.cwd ?? process.cwd(), getAgentDir())
      const edits =
        method === 'config/batchWrite' ? p.edits : [{ keyPath: p.keyPath, value: p.value }]
      for (const edit of edits)
        if (
          !['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode'].includes(
            edit.keyPath,
          )
        )
          throw new ProtocolError(-32602, `请在 Pi 原生配置中修改 ${edit.keyPath}`)
      for (const edit of edits) {
        if (edit.keyPath === 'model') {
          const index = String(edit.value).indexOf('/')
          if (index < 1) throw new ProtocolError(-32602, '模型格式必须为 provider/model')
          settings.setDefaultModelAndProvider(
            edit.value.slice(0, index),
            edit.value.slice(index + 1),
          )
        }
        if (edit.keyPath === 'model_reasoning_effort') settings.setDefaultThinkingLevel(edit.value)
      }
      await settings.flush()
      return {
        status: 'ok',
        version: 'pi',
        filePath: join(getAgentDir(), 'settings.json'),
        overriddenMetadata: null,
      }
    }
    case 'collaborationMode/list':
      return {
        data: ['default', 'plan'].map((mode) => ({
          name: mode,
          mode,
          model: null,
          reasoning_effort: null,
          developer_instructions: null,
        })),
      }
    case 'thread/start': {
      clientTools(p.dynamicTools ?? [])
      const cwd = p.cwd ?? process.cwd()
      if (typeof cwd !== 'string' || !isAbsolute(cwd))
        throw new ProtocolError(-32602, 'cwd 必须是绝对路径')
      if (p.historyMode != null && p.historyMode !== 'legacy' && p.historyMode !== 'paginated')
        throw new ProtocolError(-32602, 'historyMode 无效')
      const now = Math.floor(Date.now() / 1000)
      const thread: PiThread = {
        id: randomUUID(),
        path: null,
        cwd,
        name: null,
        preview: '',
        createdAt: now,
        updatedAt: now,
        ephemeral: p.ephemeral === true,
        model: p.model ?? p.config?.model ?? null,
        effort: p.effort ?? p.config?.model_reasoning_effort ?? null,
        planMode: false,
        dynamicTools: p.dynamicTools ?? [],
        forkedFromId: null,
      }
      if (p.allowProviderModelFallback) {
        const runtime = await ModelRuntime.create({
          authPath: join(getAgentDir(), 'auth.json'),
          modelsPath: join(getAgentDir(), 'models.json'),
        })
        if (!runtime.getModels().some((m) => `${m.provider}/${m.id}` === thread.model))
          thread.model = null
      }
      const live = await s.load(thread, peer)
      // 会话标识来自 Pi；仅临时索引尚未创建执行上下文。
      const oldId = thread.id
      thread.id = live.session.sessionId
      s.sessions.delete(oldId)
      s.store.delete(oldId)
      s.sessions.set(thread.id, live)
      s.store.saveThread(thread)
      // 记录客户端创建会话时选择的历史契约，供 thread 投影如实回报。
      if (p.historyMode != null)
        s.store.setMeta('thread', thread.id, {
          ...(s.store.getMeta('thread', thread.id) ?? {}),
          historyMode: p.historyMode,
        })
      s.subscribe(peer, thread.id)
      if (p.projectId) s.projects.assignThread(thread.id, p.projectId)
      if (p.collaborationMode?.mode === 'plan') {
        await live.session.prompt('/plan start')
        thread.planMode = true
        s.store.saveThread(thread)
      }
      const startedThread = s.envelope(thread, false)
      setImmediate(() => s.notify(thread.id, 'thread/started', { thread: startedThread }))
      return s.settings(thread)
    }
    case 'thread/list': {
      if (p.parentThreadId && p.ancestorThreadId)
        throw new ProtocolError(-32602, 'parentThreadId 与 ancestorThreadId 不能同时使用')
      await s.index(p.cwd)
      if (p.archived === true) return { data: [], nextCursor: null }
      const threads = s.store.threads()
      const byId = new Map(threads.map((thread) => [thread.id, thread]))
      const rows = threads.filter(
        (t) =>
          !t.ephemeral &&
          (p.parentThreadId ? t.parentThreadId === p.parentThreadId : true) &&
          (p.ancestorThreadId ? s.ancestors(t, byId).includes(p.ancestorThreadId) : true) &&
          (p.sourceKinds?.length
            ? p.sourceKinds.includes(t.parentThreadId ? 'subAgentThreadSpawn' : 'appServer')
            : p.parentThreadId || p.ancestorThreadId || !t.parentThreadId) &&
          (p.cwd == null || (Array.isArray(p.cwd) ? p.cwd.includes(t.cwd) : t.cwd === p.cwd)) &&
          (p.projectId === undefined || s.projects.projectId(t.id) === p.projectId) &&
          // sectionId 省略为全部、null 为未分组、字符串为指定分组；桌面据此区分置顶与普通会话。
          (p.sectionId === undefined ||
            (s.store.getMeta('thread', t.id)?.sectionId ?? null) === p.sectionId) &&
          (typeof p.isPinned !== 'boolean' ||
            (s.store.getMeta('thread', t.id)?.sectionId === PINNED_SECTION_ID) === p.isPinned) &&
          (!p.searchTerm || `${t.name ?? ''} ${t.preview}`.includes(p.searchTerm)),
      )
      return pageRecords(
        rows.map((t) => s.envelope(t, false, byId)),
        p,
        `threads:${JSON.stringify([p.projectId !== undefined, p.projectId, p.sectionId !== undefined, p.sectionId, p.isPinned, p.cwd, p.parentThreadId, p.ancestorThreadId, p.sourceKinds, p.searchTerm])}`,
        (t) => t.id,
      )
    }
    case 'thread/loaded/list':
      return { data: [...s.sessions.keys()], nextCursor: null }
    case 'thread/resume':
    case 'thread/read': {
      await s.index()
      const thread = s.store.thread(p.threadId)
      s.subscribe(peer, thread.id)
      if (method === 'thread/resume' && !s.active.has(thread.id)) await s.load(thread, peer, true)
      return method === 'thread/resume'
        ? s.settings(thread)
        : { thread: s.envelope(thread, p.includeTurns !== false) }
    }
    case 'thread/unsubscribe': {
      const subscribed = s.subscriptions.get(p.threadId)?.delete(peer.id)
      return {
        status: subscribed
          ? 'unsubscribed'
          : s.sessions.has(p.threadId)
            ? 'notSubscribed'
            : 'notLoaded',
      }
    }
    case 'turn/start':
      return { turn: s.start(peer, s.store.thread(p.threadId), p) }
    case 'turn/interrupt':
      await s.interrupt(p.threadId)
      return {}
    case 'turn/steer': {
      const clientId = p.clientUserMessageId ?? p.clientMessageId
      const old = clientId ? s.store.getMeta(`steer:${p.threadId}`, clientId) : null
      if (old) {
        if (JSON.stringify(old.input) !== JSON.stringify(p.input))
          throw new ProtocolError(-32009, '插话 ID 已被不同输入使用')
        return { turnId: old.turnId }
      }
      const active = s.active.get(p.threadId)
      if (!active?.live || active.turn.id !== p.expectedTurnId)
        throw new ProtocolError(-32009, '指定回合与活动回合不一致')
      const { text, images } = await promptInput(p.input)
      await active.live.session.steer(text, images)
      if (clientId) {
        active.live.session.sessionManager.appendCustomEntry('codex-harness-adapter-steer', {
          clientId,
        })
        active.pendingClientIds.push(clientId)
        s.store.setMeta(`steer:${p.threadId}`, clientId, { input: p.input, turnId: active.turn.id })
      }
      return { turnId: active.turn.id }
    }
    case 'thread/name/set': {
      const thread = s.store.thread(p.threadId),
        live = await s.load(thread, peer)
      live.session.setSessionName(requiredString(p.name, 'name'))
      thread.name = live.session.sessionName ?? null
      s.store.saveThread(thread)
      s.notify(thread.id, 'thread/name/updated', { threadName: thread.name })
      return {}
    }
    case 'thread/settings/update':
    case 'turn/settings/update': {
      const thread = s.store.thread(p.threadId),
        live = await s.load(thread, peer)
      if (p.model) {
        const model = live.session.modelRuntime
          .getModels()
          .find((m) => `${m.provider}/${m.id}` === p.model)
        if (!model) throw new ProtocolError(-32602, '未知 Pi 模型')
        await live.session.setModel(model)
        thread.model = p.model
      }
      if (p.effort) {
        live.session.setThinkingLevel(p.effort)
        thread.effort = live.session.thinkingLevel
      }
      const mode = p.collaborationMode?.mode
      if (mode === 'plan' && !planState(live.session).enabled)
        await live.session.prompt('/plan start')
      if (mode === 'default' && planState(live.session).enabled)
        await live.session.prompt('/plan exit')
      thread.planMode = Boolean(planState(live.session).enabled)
      s.store.saveThread(thread)
      s.notify(thread.id, 'thread/settings/updated', { threadSettings: s.settings(thread) })
      return method === 'turn/settings/update' ? { status: 'applied' } : {}
    }
    case 'thread/turns/list':
      return pageRecords(s.store.turns(p.threadId), p, `turns:${p.threadId}`, (t) => t.id)
    case 'thread/turns/items/list':
    case 'thread/items/list': {
      const items = s.store
        .turns(p.threadId)
        .filter((t) => !p.turnId || t.id === p.turnId)
        .flatMap((t) => t.items.map((item) => ({ turnId: t.id, item })))
      return pageRecords(
        items,
        p,
        `items:${p.threadId}:${p.turnId ?? ''}`,
        (i) => `${i.turnId}:${i.item.id}`,
      )
    }
    case 'thread/timeline/list': {
      const rows = s.store.turns(p.threadId).flatMap((t) => [
        { key: `${t.id}:start`, type: 'turnStarted', turnId: t.id, startedAt: t.startedAt },
        ...t.items.map((item) => ({ key: item.id, type: 'item', turnId: t.id, item })),
        ...(t.status === 'inProgress'
          ? []
          : [
              {
                key: `${t.id}:end`,
                type: 'turnCompleted',
                turnId: t.id,
                status: t.status,
                error: t.error,
                completedAt: t.completedAt,
              },
            ]),
      ])
      const page = pageRecords(
        rows,
        { ...p, sortDirection: 'desc' },
        `timeline:${p.threadId}`,
        (r) => r.key,
      )
      return {
        data: page.data.reverse(),
        nextCursor: page.nextCursor,
        activeRealtimeSessionAtPageStart: null,
      }
    }
    case 'thread/fork':
    case 'thread/rollback':
    case 'thread/revert':
    case 'thread/delete':
      return nativeMutation(s, peer, method, p)
    case 'thread/compact/start':
      s.start(peer, s.store.thread(p.threadId), { input: [], piCompact: true })
      return {}
    case 'thread/shellCommand': {
      const command = requiredString(p.command, 'command')
      if (command.includes('\0')) throw new ProtocolError(-32602, 'command 不能包含空字节')
      const cwd = s.store.thread(p.threadId).cwd
      void s.processes
        .start(peer, 'command', {
          command: [process.env.SHELL || '/bin/sh', '-lc', command],
          cwd,
          processId: randomUUID(),
          streamStdoutStderr: true,
          disableTimeout: true,
        })
        .catch((error) => s.notify(p.threadId, 'warning', { message: String(error) }))
      return {}
    }
    case 'thread/backgroundTerminals/list':
      return { terminals: [] }
    case 'thread/backgroundTerminals/clean':
      return {}
    case 'thread/increment_elicitation':
    case 'thread/decrement_elicitation':
      return {}
    case 'skills/list': {
      const data = []
      for (const cwd of p.cwds ?? [process.cwd()]) {
        const { skills, errors } = await skillsAt(cwd)
        data.push({ cwd, skills, errors })
      }
      return { data }
    }
    case 'skills/config/write': {
      if (s.active.size) throw new ProtocolError(-32009, '活动回合期间不能更改技能开关')
      const result = await writeSkill(p.cwd ?? process.cwd(), p)
      for (const live of s.sessions.values()) await live.session.reload()
      return result
    }
    case 'fuzzyFileSearch':
      return s.search.search(p)
    case 'fuzzyFileSearch/sessionStart':
      return s.searches.start(peer, p)
    case 'fuzzyFileSearch/sessionUpdate':
      return s.searches.update(peer, p)
    case 'fuzzyFileSearch/sessionStop':
      return s.searches.stop(p)
    case 'gitDiffToRemote':
      return gitDiffToRemote(p.cwd ?? process.cwd())
    case 'thread/archive':
    case 'thread/unarchive':
    case 'review/start':
      throw new ProtocolError(-32601, `Pi 首期不支持 ${method}`)
    case 'mcpServerStatus/list':
    case 'mcpServer/oauth/login':
    case 'mcpServer/resource/read':
    case 'mcpServer/tool/call':
    case 'mcpServer/event/stream/start':
    case 'mcpServer/event/stream/stop':
    case 'config/mcpServer/reload':
      throw new ProtocolError(
        -32601,
        'Pi 原生 MCP 由官方扩展管理；当前 SDK 未公开客户端管理接口，请使用 Pi 原生配置。模型仍可调用原生 MCP 工具。',
      )
    default:
      throw new ProtocolError(-32601, `Pi 不支持 ${method}`)
  }
}

async function nativeMutation(s: PiServer, peer: RpcPeer, method: string, p: any): Promise<any> {
  const thread = s.store.thread(p.threadId)
  if (s.active.has(thread.id)) throw new ProtocolError(-32009, '活动会话不能执行此操作')
  const live = await s.load(thread, peer, true),
    session = live.session
  if (method === 'thread/delete') {
    await live.dispose()
    s.sessions.delete(thread.id)
    if (thread.path)
      await unlink(thread.path).catch((e) => {
        if (e.code !== 'ENOENT') throw e
      })
    s.store.db.prepare('DELETE FROM queued_submissions WHERE thread_id=?').run(thread.id)
    s.store.db.prepare('DELETE FROM project_threads WHERE thread_id=?').run(thread.id)
    s.store.db.prepare('DELETE FROM live_project_threads WHERE thread_id=?').run(thread.id)
    s.store.delete(thread.id)
    s.notify(thread.id, 'thread/deleted', {})
    return {}
  }
  if (method === 'thread/fork') {
    if (!thread.path) throw new ProtocolError(-32602, '尚无原生会话文件')
    const manager = SessionManager.forkFrom(thread.path, thread.cwd, sessionDirectory(thread.cwd))
    const fork = {
      ...thread,
      id: manager.getSessionId(),
      path: manager.getSessionFile() ?? null,
      forkedFromId: thread.id,
      createdAt: Math.floor(Date.now() / 1000),
    }
    s.store.saveThread(fork)
    s.subscribe(peer, fork.id)
    await s.load(fork, peer)
    return s.settings(fork)
  }
  const turns = s.store.turns(thread.id)
  const count =
    method === 'thread/revert'
      ? turns.length - turns.findIndex((t) => t.id === p.beforeTurnId)
      : p.numTurns
  if (!Number.isInteger(count) || count < 1 || count > turns.length)
    throw new ProtocolError(-32602, '无效回退边界')
  const firstRemoved = turns[turns.length - count]!
  const branch = session.sessionManager.getBranch()
  const entry =
    branch.find(
      (e) =>
        e.type === 'custom' &&
        e.customType === 'codex-harness-adapter-turn' &&
        (e.data as any)?.id === firstRemoved.id,
    ) ?? branch.find((e) => `native:${e.id}` === firstRemoved.id)
  if (!entry) throw new ProtocolError(-32602, '无法定位原生会话边界')
  if (entry.parentId) await session.navigateTree(entry.parentId, { summarize: false })
  else {
    session.sessionManager.resetLeaf()
    session.refreshContext()
  }
  session.sessionManager.appendCustomEntry('codex-harness-adapter-branch', { operation: method })
  s.store.replaceTurns(thread.id, projectHistory(session.sessionManager.getBranch(), thread))
  s.notify(thread.id, 'thread/reverted', {})
  return { thread: s.envelope(thread), turnsBackwardsCursor: null, itemsBackwardsCursor: null }
}
