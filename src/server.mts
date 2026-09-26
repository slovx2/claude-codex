import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { allowsApproval } from './approval-policy.mjs'
import { buildInfo } from './build-info.mjs'
import { catalogPagination } from './catalog-pagination.mjs'
import { listClaudeHooks, listClaudeSkills } from './claude-capabilities.mjs'
import { dynamicToolResult } from './dynamic-tool-result.mjs'
import { FilesystemRpc } from './filesystem-rpc.mjs'
import { fuzzyPathMatch } from './fuzzy-search.mjs'
import { readMcpConfig } from './mcp.mjs'
import { sdkMcpServers } from './mcp-config.mjs'
import { elicitationParams, elicitationResponse } from './mcp-elicitation.mjs'
import { type McpCallbacks, McpRpc, type McpScope } from './mcp-rpc.mjs'
import { PendingInteractions } from './pending-interactions.mjs'
import { ProcessRpc } from './process-rpc.mjs'
import {
  ProtocolError,
  pageRecords,
  rejectForeignModel,
  requiredString,
  submissionHash,
  validateRuntimePermissions,
} from './protocol-contract.mjs'
import { projectProviderLoopConfig } from './provider-loop-config.mjs'
import {
  hasProviderLoopSelectionInput,
  isProviderLoopSelectionConfigKey,
  type ProviderLoopSelectionInput,
  providerLoopSelectionInputFromConfig,
  providerLoopSelectionInputFromEnv,
  resolveProviderLoopSelection,
} from './provider-loop-selection.mjs'
import { recordRunEvent } from './run-registry.mjs'
import { normalizeRuntimeType } from './runtime-config.mjs'
import { defaultSandboxPolicy, policyFromParams } from './sandbox-policy.mjs'
import {
  addedFileDiff,
  allSelectableModelOptions,
  asRecord,
  buildSystemPromptAddendum,
  coerceStructuredValue,
  commandArray,
  commandEnv,
  compactSummary,
  conciseStructuredString,
  configEdits,
  configLayerMetadata,
  defaultSelectableModelId,
  emptyTokenBreakdown,
  fallbackStructuredText,
  fileChangeFromTool,
  gitDiff,
  gitUntrackedDiff,
  hasLegacyPermissionParams,
  isGitWorkTree,
  isNotAGitRepo,
  isSubagentToolName,
  listFiles,
  modelFromParams,
  normalizeApprovalPolicy,
  normalizeDecision,
  normalizePersonality,
  normalizeReasoningEffortEnum,
  normalizeSandboxMode,
  normalizeSelectableModelId,
  normalizeSessionSource,
  normalizeThreadSource,
  normalizeUserInputAnswers,
  nullIfEmpty,
  numberOr,
  parseExitCodeFromResult,
  parseSubagentTrailer,
  parseWebSearchAction,
  permissionProfileIdFromParams,
  permissionProfileList,
  permissionProfilePolicy,
  personalityPromptCue,
  readConfigReasoningEffort,
  reasoningEffortFromParams,
  reviewLabel,
  reviewPrompt,
  sandboxEnvelope,
  sandboxFromTurnParams,
  simpleDiff,
  stringListFromEnv,
  stringOr,
  summarizeInjectedItem,
  summarizeRpcParams,
  threadPermissionProfileId,
  todoWriteToPlanSteps,
  tokenBreakdownFromClaudeUsage,
  toolResultText,
  userInputAnswersAsContent,
  wrapMcpToolError,
  wrapMcpToolResult,
} from './server-helpers.mjs'
import { PINNED_SECTION_ID, type SessionStore } from './store.mjs'
import { patchThreadGoal } from './thread-goals.mjs'
import { patchGitInfo } from './thread-metadata.mjs'
import type {
  ClaudeRuntime,
  FileUpdateChange,
  ImageInput,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  PermissionDecision,
  RpcPeer,
  RuntimeEvent,
  ThreadItem,
  ThreadRecord,
  ThreadSectionAppearance,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TurnRecord,
  UserInput,
  UserInputAnswers,
  UserInputQuestion,
  WireMessage,
} from './types.mjs'
import {
  adapterHome,
  claudeOutputFormat,
  codexCliVersion,
  codexHome,
  codexUserAgent,
  debugLog,
  defaultAllowedTools,
  ensureParent,
  extractImageInputs,
  isCodexOpenAiModel,
  newId,
  normalizeCodexReasoningEffort,
  nowMillis,
  nowSeconds,
  platformFamily,
  platformOs,
  resolveClaudeEffort,
  resolveClaudeModel,
  textFromInput,
} from './util.mjs'
import { parseWorkflowCommand } from './workflow-command.mjs'
import { maybeCreateThreadWorktree } from './worktree.mjs'

const execFileAsync = promisify(execFile)

// A missing Claude Task result must not keep Codex cc in its working state
// forever. This is deliberately a long, configurable watchdog for the whole
// subagent phase; it is not the short journal-drain grace period used when a
// terminal notification has already arrived.
const DEFAULT_SUBAGENT_WATCHDOG_MS = 30 * 60 * 1000
const MIN_SUBAGENT_WATCHDOG_MS = 100

function isWorkflowToolName(value: string): boolean {
  const name = value.trim().toLowerCase()
  return name === 'workflow' || name === 'workflows'
}

function subagentWatchdogTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_SUBAGENT_WATCHDOG_MS
  const parsed = Number(raw)
  // Zero is the documented opt-out. Invalid and negative values must fall
  // back to the bounded default rather than silently reintroducing an
  // unbounded loading state.
  if (!Number.isFinite(parsed)) return DEFAULT_SUBAGENT_WATCHDOG_MS
  if (parsed === 0) return 0
  if (parsed < 0) return DEFAULT_SUBAGENT_WATCHDOG_MS
  return Math.max(MIN_SUBAGENT_WATCHDOG_MS, Math.floor(parsed))
}

type TurnItemsView = 'full' | 'summary' | 'notLoaded'

interface SubagentContext {
  childThreadId: string
  childTurnId: string
  waitItemId: string
  agentPath: string
  prompt: string
  subType: string | null
}

interface ActiveSubagentState {
  thread: ThreadRecord
  turn: TurnRecord
  contexts: Map<string, SubagentContext>
  active: Set<string>
}

interface PeerFeatures {
  // Codex cc 26.818.61809 only accepts started/interacted/interrupted in the
  // subAgentActivity schema. Newer clients may opt into the completed kind
  // explicitly during initialize; keep the legacy wire shape otherwise.
  supportsCompletedSubagentActivity: boolean
}

function turnItemsView(value: unknown): TurnItemsView {
  if (value === 'full' || value === 'summary' || value === 'notLoaded') return value
  return 'summary'
}

export class CodexClaudeAppServer {
  private pendingInteractions = new PendingInteractions()
  private activePeerByThread = new Map<string, RpcPeer>()
  private peerFeatures = new WeakMap<RpcPeer, PeerFeatures>()
  private activeTurnByThread = new Map<string, string>()
  private interruptingByThread = new Map<string, Promise<void>>()
  private activeItemsByTurn = new Map<string, Set<string>>()
  private runtimeReadyByTurn = new Map<
    string,
    {
      ready: Promise<boolean>
      resolve: (started: boolean) => void
    }
  >()
  private nativeMutations = new Set<string>()
  private subagentStateByTurn = new Map<string, ActiveSubagentState>()
  private fuzzySessions = new Map<string, { roots: string[] }>()
  private commandSessionAllow = new Map<string, Set<string>>()
  private commandProcesses = new Map<string, ChildProcess>()
  private readonly processes = new ProcessRpc()
  private readonly filesystem = new FilesystemRpc()
  private readonly mcp = new McpRpc()
  private elicitationCounts = new Map<string, number>()
  private configModel = defaultSelectableModelId()
  private configReasoningEffort =
    normalizeCodexReasoningEffort(process.env.CLAUDE_CODEX_DEFAULT_EFFORT) ?? 'medium'
  // Catch-all for arbitrary keys the App's settings sheet writes (approval
  // policy, sandbox preference, instructions toggles, etc.). We don't apply
  // them to typed runtime state, but we round-trip them through config/read
  // so the user's settings survive a daemon restart instead of resetting on
  // every reconnect.
  private configOverrides: Record<string, unknown> = {}
  private readonly configPath = join(adapterHome(), 'config.json')
  private idleCheckHandler: (() => void) | null = null
  private stopped = false
  private readonly store: SessionStore
  private readonly runtime: ClaudeRuntime

  constructor(store: SessionStore, runtime: ClaudeRuntime) {
    this.store = store
    this.runtime = runtime
    this.loadPersistedConfig()
  }

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    if ('method' in message && message.method) {
      debugLog('rpc.request', {
        peerId: peer.id,
        id: 'id' in message ? message.id : null,
        method: message.method,
        params: summarizeRpcParams(message.method, message.params),
      })
      if ('id' in message) {
        await this.handleRequest(peer, message as JsonRpcRequest)
      } else {
        await this.handleNotification(peer, message)
      }
      return
    }
    if ('id' in message) {
      debugLog('rpc.responseFromClient', {
        peerId: peer.id,
        id: message.id,
        hasError: Boolean((message as JsonRpcResponse).error),
      })
      this.pendingInteractions.resolve(peer, message as JsonRpcResponse)
    }
  }

  closePeer(peer: RpcPeer): void {
    this.mcp.closePeer(peer.id)
    this.pendingInteractions.cancelPeer(peer.id)
    this.filesystem.closePeer(peer.id)
    this.processes.closePeer(peer.id)
    debugLog('peer.close', { peerId: peer.id })
    for (const [threadId, activePeer] of this.activePeerByThread.entries()) {
      if (activePeer.id === peer.id) this.activePeerByThread.delete(threadId)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.mcp.close()
    this.filesystem.close()
    await this.processes.close()
    // Child turns are created directly from Task/Workflow events and are not
    // registered in activeTurnByThread. Finalize them before aborting the
    // runtime or closing SQLite, otherwise stdio EOF can leave child turns
    // persisted as inProgress until a later restart recovery pass.
    this.finalizeActiveSubagentsForShutdown('server stopped')
    this.completeActiveTurns('interrupted', { message: 'server stopped' })
    await this.runtime.stop()
    this.pendingInteractions.close()
    this.store.close()
  }

  hasActiveTurns(): boolean {
    return this.activeTurnByThread.size > 0
  }

  setIdleCheckHandler(handler: () => void): void {
    this.idleCheckHandler = handler
  }

  private async handleNotification(_peer: RpcPeer, _message: WireMessage): Promise<void> {
    // Currently only `initialized` is expected from clients.
  }

  private async handleRequest(peer: RpcPeer, request: JsonRpcRequest): Promise<void> {
    const threadId = asRecord(request.params).threadId
    const nativeMutation = ['thread/fork', 'thread/rollback'].includes(request.method)
    let locked = false
    try {
      if (typeof threadId === 'string' && this.nativeMutations.has(threadId))
        throw new ProtocolError(-32009, '原生会话正在变更，请稍后重试')
      if (nativeMutation && typeof threadId === 'string') {
        this.nativeMutations.add(threadId)
        locked = true
      }
      const result = await this.dispatch(peer, request.method, request.params ?? {})
      debugLog('rpc.response', {
        peerId: peer.id,
        id: request.id,
        method: request.method,
        ok: true,
      })
      this.sendResponse(peer, request.id, result)
    } catch (error) {
      debugLog('rpc.response', {
        peerId: peer.id,
        id: request.id,
        method: request.method,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      })
      this.sendResponse(peer, request.id, undefined, {
        code: error instanceof ProtocolError ? error.code : -32000,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (locked) this.nativeMutations.delete(threadId as string)
    }
  }

  private async dispatch(peer: RpcPeer, method: string, params: unknown): Promise<unknown> {
    if (params === null || typeof params !== 'object' || Array.isArray(params))
      throw new ProtocolError(-32602, 'params 必须是对象')
    if (
      [
        'thread/start',
        'thread/resume',
        'thread/fork',
        'turn/start',
        'thread/settings/update',
        'thread/metadata/update',
      ].includes(method)
    )
      validateRuntimePermissions(asRecord(params))
    rejectForeignModel(asRecord(params).model)
    rejectForeignModel(asRecord(asRecord(params).config).model)
    if (
      [
        'plugin/install',
        'plugin/installed',
        'plugin/list',
        'plugin/read',
        'plugin/share/checkout',
        'plugin/share/delete',
        'plugin/share/list',
        'plugin/share/save',
        'plugin/share/updateTargets',
        'plugin/skill/read',
        'plugin/uninstall',
        'marketplace/add',
        'marketplace/remove',
        'marketplace/upgrade',
        'account/login/start',
        'account/login/cancel',
        'account/logout',
        'account/sendAddCreditsNudgeEmail',
        'account/rateLimitResetCredit/consume',
        'account/usage/read',
        'account/workspaceMessages/read',
        'account/rateLimits/read',
        'feedback/upload',
        'attestation/generate',
        'environment/add',
      ].includes(method)
    )
      throw new ProtocolError(-32004, `Claude 运行时不适用此能力: ${method}`)
    switch (method) {
      case 'runtime/info':
        return buildInfo()
      case 'initialize': {
        const initParams = asRecord(params)
        const clientInfo = asRecord(initParams.clientInfo)
        const capabilities = asRecord(initParams.capabilities)
        const declaredActivityKinds = Array.isArray(capabilities.subAgentActivityKinds)
          ? capabilities.subAgentActivityKinds
          : []
        this.peerFeatures.set(peer, {
          supportsCompletedSubagentActivity:
            capabilities.subAgentActivityCompleted === true ||
            declaredActivityKinds.includes('completed') ||
            process.env.CLAUDE_CODEX_SUBAGENT_COMPLETED === '1',
        })
        // Push the account snapshot + MCP server statuses right after handshake
        // so the App's sidebar avatar and MCP panel populate without waiting
        // for the next polling cycle. Without these the avatar stays "signed
        // out" and the MCP list never reflects current boot state.
        queueMicrotask(() => {
          this.notify(peer, {
            method: 'account/updated',
            params: { authMode: 'apikey', planType: null },
          })
          void Promise.resolve()
            .then(() => this.mcpProbe(peer, this.mcpScope()))
            .catch((error: unknown) => {
              this.notify(peer, {
                method: 'mcpServer/startupStatus/updated',
                params: {
                  name: 'MCP configuration',
                  status: 'failed',
                  error: String(error),
                  threadId: null,
                },
              })
            })
        })
        return {
          userAgent: codexUserAgent(
            stringOr(clientInfo.name, 'codex-app'),
            stringOr(clientInfo.version, 'unknown'),
          ),
          codexHome: codexHome(),
          platformFamily: platformFamily(),
          platformOs: platformOs(),
        }
      }
      case 'thread/start':
        return this.threadStart(peer, asRecord(params))
      case 'thread/resume':
        return this.threadResume(peer, asRecord(params))
      case 'thread/fork':
        return this.threadFork(peer, asRecord(params))
      case 'thread/list':
        return this.threadList(asRecord(params))
      case 'thread/read':
        return this.threadRead(asRecord(params))
      case 'thread/turns/list':
        return this.threadTurnsList(asRecord(params))
      case 'thread/items/list':
        return this.threadItemsList(asRecord(params))
      case 'thread/delete': {
        const threadId = requiredString(asRecord(params).threadId, 'threadId')
        if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
        if (this.activeTurnByThread.has(threadId))
          throw new ProtocolError(-32009, '活动会话不能删除')
        this.store.deleteThread(threadId)
        this.notifyThread(threadId, { method: 'thread/closed', params: { threadId } })
        this.activePeerByThread.delete(threadId)
        this.clearThreadState(threadId)
        return {}
      }
      case 'thread/turns/items/list':
        return this.threadTurnItemsList(asRecord(params))
      case 'thread/name/set':
        return this.threadNameSet(asRecord(params))
      case 'thread/archive':
        return this.threadArchive(asRecord(params), true)
      case 'thread/unsubscribe':
        return this.threadUnsubscribe(peer, asRecord(params))
      case 'thread/increment_elicitation':
        return this.threadAdjustElicitation(asRecord(params), 1)
      case 'thread/decrement_elicitation':
        return this.threadAdjustElicitation(asRecord(params), -1)
      case 'thread/goal/set':
        return this.threadGoalSet(asRecord(params))
      case 'thread/goal/get':
        return this.threadGoalGet(asRecord(params))
      case 'thread/goal/clear':
        return this.threadGoalClear(asRecord(params))
      case 'thread/metadata/update':
        return this.threadMetadataUpdate(asRecord(params))
      case 'thread/section/move':
        return this.threadSectionMove(asRecord(params))
      case 'threadSection/list':
        return this.threadSectionList(asRecord(params))
      case 'threadSection/create':
        return this.threadSectionCreate(asRecord(params))
      case 'threadSection/update':
        return this.threadSectionUpdate(asRecord(params))
      case 'threadSection/delete':
        return this.threadSectionDelete(asRecord(params))
      case 'thread/settings/update':
        return this.threadSettingsUpdate(peer, asRecord(params))
      // Intentional no-ops: Claude Code has no equivalent concept, so the
      // adapter acknowledges the call without side effects rather than failing
      // the RPC (which would break the Codex App connection).
      case 'thread/memoryMode/set':
      case 'memory/reset':
        return {}
      case 'thread/unarchive':
        return this.threadArchive(asRecord(params), false)
      case 'thread/compact/start':
        return this.threadCompactStart(peer, asRecord(params))
      case 'thread/shellCommand':
        return this.threadShellCommand(peer, asRecord(params))
      case 'thread/approveGuardianDeniedAction': {
        // Codex App's "Guardian" is an OpenAI-side pre-tool safety classifier
        // that can deny a tool call before it reaches the runtime. Claude
        // Code has no equivalent — every denial in our pipeline already
        // routes through the canUseTool round-trip, which the user resolves
        // directly via the standard approval modal. There is no separate
        // guardian-denied action to retry. We log the event (for parity
        // debugging) and ack with the schema-correct {} response.
        const evt = asRecord(params).event
        debugLog('thread.approveGuardianDeniedAction', {
          threadId: stringOr(asRecord(params).threadId, ''),
          eventType:
            evt && typeof evt === 'object' ? ((evt as Record<string, unknown>).type ?? null) : null,
        })
        return {}
      }
      case 'thread/backgroundTerminals/clean':
        return this.threadBackgroundTerminalsClean(asRecord(params))
      case 'thread/rollback':
        return this.threadRollback(asRecord(params))
      case 'thread/loaded/list':
        return this.threadLoadedList(asRecord(params))
      case 'thread/inject_items':
        return this.threadInjectItems(peer, asRecord(params))
      case 'turn/start':
        return this.turnStart(peer, asRecord(params))
      case 'turn/steer':
        return this.turnSteer(peer, asRecord(params))
      case 'turn/interrupt':
        return this.turnInterrupt(peer, asRecord(params))
      // Realtime voice is unsupported: Claude Code has no realtime audio
      // channel. These ack so the App's capability probe does not error; a
      // real session would need a separate audio backend.
      case 'thread/realtime/start':
      case 'thread/realtime/appendAudio':
      case 'thread/realtime/appendText':
      case 'thread/realtime/stop':
        return {}
      case 'thread/realtime/listVoices':
        return { voices: { v1: [], v2: [], defaultV1: null, defaultV2: null } }
      case 'review/start':
        return this.reviewStart(peer, asRecord(params))
      case 'config/read':
        return this.configRead()
      case 'configRequirements/read':
        return { requirements: null }
      case 'model/list':
        return this.modelList(asRecord(params))
      case 'modelProvider/capabilities/read':
        return {
          namespaceTools: true,
          imageGeneration: false,
          // Claude Code SDK ships a WebSearch tool. Default to advertising it
          // so Codex App shows the search affordance; CLAUDE_CODEX_WEBSEARCH=0
          // turns it off for environments where the tool is rate-limited.
          webSearch: process.env.CLAUDE_CODEX_WEBSEARCH !== '0',
        }
      case 'experimentalFeature/list':
        return { data: [], nextCursor: null }
      case 'permissionProfile/list':
        return permissionProfileList(asRecord(params))
      case 'experimentalFeature/enablement/set':
        return { enablement: asRecord(asRecord(params).enablement) }
      case 'collaborationMode/list':
        return {
          data: [
            { name: '直接执行', mode: 'default', model: null, reasoning_effort: null },
            { name: '先做计划', mode: 'plan', model: null, reasoning_effort: null },
          ],
        }
      case 'mock/experimentalMethod':
        return {
          echoed: typeof asRecord(params).value === 'string' ? asRecord(params).value : null,
        }
      case 'skills/list':
        return { data: listClaudeSkills(asRecord(params)) }
      case 'hooks/list':
        return { data: listClaudeHooks(asRecord(params)) }
      case 'marketplace/add':
        return this.marketplaceAdd(asRecord(params))
      case 'marketplace/remove':
        return this.marketplaceRemove(asRecord(params))
      case 'marketplace/upgrade':
        return this.marketplaceUpgrade(asRecord(params))
      case 'plugin/list':
        return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
      case 'plugin/read':
        return this.pluginRead(asRecord(params))
      case 'plugin/skill/read':
        return { contents: null }
      case 'plugin/share/save':
        return this.pluginShareSave(asRecord(params))
      case 'plugin/share/updateTargets':
        return this.pluginShareUpdateTargets(asRecord(params))
      case 'plugin/share/delete':
      case 'plugin/uninstall':
        return {}
      case 'plugin/install':
        return { authPolicy: 'ON_USE', appsNeedingAuth: [] }
      case 'skills/config/write':
        return { effectiveEnabled: asRecord(params).enabled === true }
      case 'plugin/share/list':
        return { data: [] }
      // Stub the three RPC methods Codex App may call but our dispatcher
      // previously threw "method not implemented" on. Stubs return the
      // schema-correct empty shape so the App's call sites don't surface an
      // RPC error toast.
      case 'plugin/share/checkout':
        // PluginShareCheckoutResponse — App polls after a share/save; nothing to checkout.
        return {}
      case 'environment/add':
        // EnvironmentAddResponse — adds a workspace environment; we have no concept of one.
        return {}
      case 'attestation/generate':
        // AttestationGenerateResponse — returns a signed blob; clients with
        // requestAttestation:true expect a string. Empty string is permissive.
        return { attestation: '' }
      case 'app/list':
        return { data: [], nextCursor: null }
      case 'mcpServer/oauth/login':
        throw new ProtocolError(-32001, 'MCP OAuth 尚未配置授权流程，不能提供虚假登录地址')
      case 'config/mcpServer/reload':
        return this.mcpReload(peer)
      case 'mcpServerStatus/list':
        return this.mcp.statuses(
          this.mcpScope(asRecord(params).threadId),
          asRecord(params),
          this.mcpCallbacks(peer, asRecord(params).threadId),
        )
      case 'mcpServer/resource/read':
      case 'mcpServer/tool/call':
        return this.mcpCall(peer, method, asRecord(params))
      case 'windowsSandbox/setupStart':
        return { started: false }
      case 'windowsSandbox/readiness':
        return { status: 'notConfigured' }
      case 'account/login/start':
        return { type: 'apiKey' }
      case 'account/login/cancel':
        return { status: 'notFound' }
      case 'account/logout':
        return {}
      case 'account/sendAddCreditsNudgeEmail':
        return { status: 'cooldown_active' }
      case 'feedback/upload':
        return { threadId: stringOr(asRecord(params).threadId, '') }
      case 'account/read':
        // Claude 凭据由独立运行时管理，不伪装成 OpenAI 或 Bedrock 登录。
        return { account: null, requiresOpenaiAuth: false }
      case 'account/rateLimits/read':
        return this.accountRateLimits()
      case 'fs/readFile':
      case 'fs/readDirectory':
      case 'fs/getMetadata':
      case 'fs/writeFile':
      case 'fs/createDirectory':
      case 'fs/remove':
      case 'fs/copy':
      case 'fs/watch':
      case 'fs/unwatch':
        return this.filesystem.call(peer, method, asRecord(params))
      case 'command/exec':
        return this.processes.start(peer, 'command', asRecord(params))
      case 'command/exec/write':
        return this.processes.followup(peer, 'command', 'write', asRecord(params))
      case 'command/exec/terminate':
        return this.processes.followup(peer, 'command', 'kill', asRecord(params))
      case 'command/exec/resize':
        return this.processes.followup(peer, 'command', 'resize', asRecord(params))
      case 'process/spawn':
        return this.processes.start(peer, 'process', asRecord(params))
      case 'process/writeStdin':
        return this.processes.followup(peer, 'process', 'write', asRecord(params))
      case 'process/kill':
        return this.processes.followup(peer, 'process', 'kill', asRecord(params))
      case 'process/resizePty':
        return this.processes.followup(peer, 'process', 'resize', asRecord(params))
      case 'externalAgentConfig/detect':
        return { items: [] }
      case 'externalAgentConfig/import':
        return {}
      case 'config/value/write':
      case 'config/batchWrite':
        return this.configWriteResponse(asRecord(params))
      case 'getConversationSummary':
        return this.getConversationSummary(asRecord(params))
      case 'gitDiffToRemote':
        return this.gitDiffToRemote(asRecord(params))
      case 'getAuthStatus':
        return { authMethod: null, authToken: null, requiresOpenaiAuth: false }
      case 'fuzzyFileSearch':
        return this.fuzzyFileSearch(asRecord(params))
      case 'fuzzyFileSearch/sessionStart':
        return this.fuzzySessionStart(asRecord(params))
      case 'fuzzyFileSearch/sessionUpdate':
        return this.fuzzySessionUpdate(peer, asRecord(params))
      case 'fuzzyFileSearch/sessionStop':
        return this.fuzzySessionStop(peer, asRecord(params))
      default:
        throw new ProtocolError(-32601, `method not implemented: ${method}`)
    }
  }

  private threadStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const id = newId()
    const now = nowSeconds()
    const requestedCwd = stringOr(params.cwd, process.cwd())
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    const model = modelFromParams(params, this.configModel)
    const reasoningEffort = reasoningEffortFromParams(params, this.configReasoningEffort)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    const selectedProviderLoop = resolveProviderLoopSelection(this.providerLoopSelectionInput())
    const isTitleOrHelper =
      params.ephemeral === true ||
      params.threadSource === 'title_generation' ||
      params.threadSource === 'memory_consolidation'
    const thread: ThreadRecord = {
      id,
      sessionId: id,
      forkedFromId: null,
      isPinned: false,
      sectionId: null,
      sectionEnteredAt: null,
      sectionPosition: null,
      preview: '',
      name: null,
      archived: false,
      cwd,
      model,
      reasoningEffort,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      // v2 SessionSource is camelCase; the old `app_server` falls through to
      // `unknown` on the App side, hiding the source in the thread sidebar.
      source: 'appServer',
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy:
        normalizeApprovalPolicy(params.approvalPolicy) ??
        permissionProfile?.approvalPolicy ??
        'never',
      sandboxMode:
        permissionProfile?.sandboxMode ?? sandboxFromTurnParams(params) ?? 'danger-full-access',
      permissionProfileId: permissionProfile?.id ?? null,
      ephemeral: isTitleOrHelper,
      threadSource: normalizeThreadSource(params.threadSource),
      agentRole: nullIfEmpty(typeof params.agentRole === 'string' ? params.agentRole : null),
      agentNickname: nullIfEmpty(
        typeof params.agentNickname === 'string' ? params.agentNickname : null,
      ),
      baseInstructions: nullIfEmpty(
        typeof params.baseInstructions === 'string' ? params.baseInstructions : null,
      ),
      developerInstructions: nullIfEmpty(
        typeof params.developerInstructions === 'string' ? params.developerInstructions : null,
      ),
      personality: normalizePersonality(params.personality),
      // Pick the runtime backend from the chosen model — picking gpt-* in
      // the App's model dropdown flips the new thread to runtimeBackend
      // 'codex' so turns get forwarded to `codex exec`. Default 'claude'.
      runtimeBackend: 'claude',
      codexSessionId: null,
    }
    this.store.upsertThread(thread)
    this.saveRuntimeSettings(id, params)
    recordRunEvent('thread.started', {
      threadId: thread.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.activePeerByThread.set(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(thread)
  }

  private threadResume(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error('unknown thread: ' + threadId)
    this.saveRuntimeSettings(threadId, params)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    const reasoningEffort = reasoningEffortFromParams(params, null)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    if (model) {
      // runtimeBackend is pinned at thread/start. Refuse cross-backend
      // model changes on resume — the conversation history wouldn't carry
      // over between Claude SDK and `codex exec`. App's model picker can
      // still rebind same-backend models (e.g. sonnet → opus).
      const newBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      if (newBackend === thread.runtimeBackend) {
        thread.model = model
      } else {
        debugLog('thread.resume.modelBackendMismatch', {
          threadId,
          oldModel: thread.model,
          newModel: model,
          oldBackend: thread.runtimeBackend,
          newBackend,
        })
      }
    }
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (permissionProfileId) {
      thread.permissionProfileId = permissionProfileId
      if (params.approvalPolicy != null)
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      else if (permissionProfile?.approvalPolicy)
        thread.approvalPolicy = permissionProfile.approvalPolicy
      if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    } else {
      if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
      if (params.approvalPolicy != null)
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      const sandbox = sandboxFromTurnParams(params)
      if (sandbox) thread.sandboxMode = sandbox
    }
    if (typeof params.threadSource === 'string')
      thread.threadSource = normalizeThreadSource(params.threadSource)
    if (typeof params.baseInstructions === 'string')
      thread.baseInstructions = nullIfEmpty(params.baseInstructions)
    if (typeof params.developerInstructions === 'string')
      thread.developerInstructions = nullIfEmpty(params.developerInstructions)
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)
    this.store.upsertThread(thread)
    recordRunEvent('thread.resumed', {
      threadId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.activePeerByThread.set(threadId, peer)
    // 恢复时主动回显持久化的计划与审批设置，客户端不能按本地默认值猜测。
    this.threadSettingsUpdate(peer, { threadId })
    this.bindPeerToDescendants(peer, threadId)
    const usage = this.store.threadUsage(threadId)
    if (usage)
      setImmediate(() =>
        this.notify(peer, {
          method: 'thread/tokenUsage/updated',
          params: { threadId, ...usage },
        }),
      )
    return {
      ...asRecord(
        this.threadEnvelope(
          thread,
          params.excludeTurns === true ? [] : this.store.listTurns(thread.id),
        ),
      ),
      initialTurnsPage:
        params.initialTurnsPage == null
          ? null
          : this.threadTurnsList({ ...asRecord(params.initialTurnsPage), threadId }),
    }
  }

  private async threadFork(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const parentId = stringOr(params.threadId, '')
    const parent = this.store.getThread(parentId)
    if (!parent) throw new Error(`unknown thread: ${parentId}`)
    if (this.activeTurnByThread.has(parentId)) throw new ProtocolError(-32009, '活动会话不能分叉')
    const nativeSession = parent.claudeSessionId ? await this.forkNativeSession(parent) : null
    const now = nowSeconds()
    const id = newId()
    const requestedCwd = stringOr(params.cwd, parent.cwd)
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    const thread: ThreadRecord = {
      ...parent,
      id,
      sessionId: id,
      forkedFromId: parent.id,
      isPinned: false,
      sectionId: null,
      sectionEnteredAt: null,
      sectionPosition: null,
      archived: false,
      cwd,
      model: modelFromParams(params, parent.model),
      reasoningEffort: reasoningEffortFromParams(params, parent.reasoningEffort),
      claudeSessionId: nativeSession,
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy:
        params.approvalPolicy != null
          ? normalizeApprovalPolicy(params.approvalPolicy)
          : (permissionProfilePolicy(permissionProfileIdFromParams(params))?.approvalPolicy ??
            parent.approvalPolicy),
      sandboxMode:
        permissionProfilePolicy(permissionProfileIdFromParams(params))?.sandboxMode ??
        sandboxFromTurnParams(params) ??
        parent.sandboxMode,
      permissionProfileId:
        permissionProfileIdFromParams(params) ??
        (hasLegacyPermissionParams(params) ? null : (parent.permissionProfileId ?? null)),
      ephemeral: parent.ephemeral,
      threadSource:
        typeof params.threadSource === 'string'
          ? normalizeThreadSource(params.threadSource)
          : normalizeThreadSource(parent.threadSource),
      agentRole: nullIfEmpty(
        typeof params.agentRole === 'string' ? params.agentRole : parent.agentRole,
      ),
      agentNickname: nullIfEmpty(
        typeof params.agentNickname === 'string' ? params.agentNickname : parent.agentNickname,
      ),
      baseInstructions: nullIfEmpty(
        typeof params.baseInstructions === 'string'
          ? params.baseInstructions
          : parent.baseInstructions,
      ),
      developerInstructions: nullIfEmpty(
        typeof params.developerInstructions === 'string'
          ? params.developerInstructions
          : parent.developerInstructions,
      ),
      personality:
        typeof params.personality === 'string'
          ? normalizePersonality(params.personality)
          : parent.personality,
      // Fork: model may flip backend (forking from claude-thread with a
      // gpt-* model = new codex-backed thread); otherwise inherit parent.
      runtimeBackend: 'claude',
      codexSessionId: null,
    }
    this.store.upsertThread(thread)
    this.store.saveThreadSettings(id, this.store.threadSettings(parentId))
    const parentGoal = this.store.threadGoal(parentId)
    if (parentGoal) this.store.saveThreadGoal({ ...parentGoal, threadId: id })
    const parentUsage = this.store.threadUsage(parentId)
    this.saveRuntimeSettings(id, params)
    for (const turn of this.store.listTurns(parentId)) {
      const cloned = { ...turn, id: newId(), threadId: id }
      this.store.upsertTurn(cloned)
      if (parentUsage?.turnId === turn.id)
        this.store.saveThreadUsage(id, cloned.id, parentUsage.tokenUsage)
      const boundary = this.store.nativeBoundary(turn.id)
      if (boundary) this.store.saveNativeBoundary(cloned.id, boundary)
    }
    recordRunEvent('thread.forked', {
      threadId: thread.id,
      parentThreadId: parent.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.activePeerByThread.set(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(thread, params.excludeTurns === true ? [] : this.store.listTurns(id))
  }

  private threadList(params: Record<string, unknown>): unknown {
    const sourceKinds = Array.isArray(params.sourceKinds)
      ? params.sourceKinds.filter((value): value is string => typeof value === 'string')
      : []
    const parentThreadId =
      typeof params.parentThreadId === 'string' && params.parentThreadId.length > 0
        ? params.parentThreadId
        : null
    const ancestorThreadId =
      typeof params.ancestorThreadId === 'string' && params.ancestorThreadId.length > 0
        ? params.ancestorThreadId
        : null
    const sortKey =
      params.sortKey === 'updated_at' ||
      params.sortKey === 'recency_at' ||
      params.sortKey === 'section_position'
        ? params.sortKey
        : 'created_at'
    if (
      params.sortKey != null &&
      !['created_at', 'updated_at', 'recency_at', 'section_position'].includes(
        String(params.sortKey),
      )
    )
      throw new ProtocolError(-32602, 'sortKey 无效')
    const isPinned = typeof params.isPinned === 'boolean' ? params.isPinned : null
    const sectionId =
      params.sectionId === null
        ? null
        : typeof params.sectionId === 'string'
          ? params.sectionId
          : undefined
    const modelProviders = Array.isArray(params.modelProviders)
      ? params.modelProviders.filter((value): value is string => typeof value === 'string')
      : []
    const filters = {
      archived: (params.archived as boolean | null | undefined) ?? null,
      isPinned,
      sectionId,
      cwd:
        typeof params.cwd === 'string' || Array.isArray(params.cwd)
          ? (params.cwd as string | string[])
          : null,
      includeEphemeral: params.includeEphemeral === true,
      parentThreadId,
      ancestorThreadId,
      sourceKinds,
      sortKey,
      modelProviders,
      searchTerm: typeof params.searchTerm === 'string' ? params.searchTerm : null,
    }
    const pagination = catalogPagination(params, submissionHash(filters))
    const found = this.store.listThreads({
      ...filters,
      sortKey,
      sortDirection: pagination.sortDirection,
      cursor: pagination.cursor,
      limit: pagination.limit + 1,
    })
    const threads = found.slice(0, pagination.limit)
    const last = threads.at(-1)
    const cursorValue = (thread: ThreadRecord): number =>
      sortKey === 'section_position'
        ? (thread.sectionPosition ?? thread.createdAt)
        : sortKey === 'created_at'
          ? thread.createdAt
          : thread.updatedAt
    return {
      data: threads.map((thread) => this.toThread(thread, [])),
      nextCursor:
        last && found.length > pagination.limit
          ? pagination.encode(cursorValue(last), last.id)
          : null,
      backwardsCursor: threads[0]
        ? pagination.encode(cursorValue(threads[0]), threads[0].id, true)
        : null,
    }
  }

  private threadSectionMove(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    if (params.sectionId !== null && typeof params.sectionId !== 'string')
      throw new Error('sectionId must be a string or null')
    const sectionId = params.sectionId === null ? null : params.sectionId
    if (sectionId === '') throw new Error('sectionId must not be empty')
    const beforeThreadId =
      typeof params.beforeThreadId === 'string' && params.beforeThreadId.length > 0
        ? params.beforeThreadId
        : null
    const moved = this.store.moveThreadToSection(threadId, sectionId, beforeThreadId)
    debugLog('thread.section.moved', {
      threadId,
      sectionId: moved.sectionId ?? null,
      isPinned: moved.isPinned === true,
      beforeThreadId,
    })
    return {}
  }

  private threadSectionList(params: Record<string, unknown>): unknown {
    const requestedLimit = numberOr(params.limit, 100)
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.floor(requestedLimit), 200))
      : 100
    const offset = typeof params.cursor === 'string' ? Number(params.cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid section cursor')
    const sections = this.store.listSections(limit, String(offset))
    const nextOffset = offset + sections.length
    const hasMore = this.store.listSections(1, String(nextOffset)).length > 0
    return { data: sections, nextCursor: hasMore ? String(nextOffset) : null }
  }

  private threadSectionCreate(params: Record<string, unknown>): unknown {
    const name = stringOr(params.name, '')
    const section = this.store.createSection(
      newId(),
      name,
      this.sectionAppearance(params.appearance),
    )
    return { section }
  }

  private threadSectionUpdate(params: Record<string, unknown>): unknown {
    const sectionId = stringOr(params.sectionId, '')
    const existing = this.store.getSection(sectionId)
    if (!existing) throw new Error(`unknown section: ${sectionId}`)
    const name = typeof params.name === 'string' ? params.name : existing.name
    const appearance =
      params.appearance === undefined
        ? existing.appearance
        : this.sectionAppearance(params.appearance)
    return { section: this.store.updateSection(sectionId, name, appearance) }
  }

  private threadSectionDelete(params: Record<string, unknown>): unknown {
    this.store.deleteSection(stringOr(params.sectionId, ''))
    return {}
  }

  private sectionAppearance(value: unknown): ThreadSectionAppearance | null {
    if (value == null) return null
    const record = asRecord(value)
    return {
      color: typeof record.color === 'string' ? record.color : null,
      icon: typeof record.icon === 'string' ? record.icon : null,
    }
  }

  private threadRead(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    // Codex cc hydrates the Subagent panel with includeTurns:false. A
    // parent-linked child with no renderable turns is treated by that client
    // as still loading, and it does not reliably follow up with turns/list.
    // Keep metadata-only reads for ordinary threads, but return the small
    // child transcript so Prompt/Response and the terminal state can render.
    const includeTurns = params.includeTurns !== false || thread.threadSource === 'subagent'
    const turns = includeTurns ? this.store.listTurns(threadId) : []
    return { thread: this.toThread(thread, turns) }
  }

  private threadTurnsList(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
    const itemsView = turnItemsView(params.itemsView)
    const page = pageRecords(
      this.store.listTurns(threadId),
      params,
      `turns:${threadId}`,
      (turn) => turn.id,
    )
    return { ...page, data: page.data.map((turn) => this.toTurnView(turn, itemsView)) }
  }

  private threadItemsList(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
    const items = this.store
      .listTurns(threadId)
      .filter((turn) => params.turnId == null || turn.id === params.turnId)
      .flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })))
    return pageRecords(
      items,
      { ...params, sortDirection: params.sortDirection ?? 'asc' },
      `items:${threadId}:${params.turnId ?? ''}`,
      (entry) => `${entry.turnId}:${entry.item.id}`,
    )
  }

  private saveRuntimeSettings(threadId: string, params: Record<string, unknown>): void {
    const settings = this.store.threadSettings(threadId)
    const thread = this.store.getThread(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    const cwd = typeof params.cwd === 'string' ? params.cwd : thread.cwd
    settings.sandboxPolicy = policyFromParams(
      params,
      cwd,
      settings.sandboxPolicy ?? defaultSandboxPolicy(thread.sandboxMode, cwd),
    )
    const mode = asRecord(params.collaborationMode).mode
    if (mode === 'plan' || mode === 'default') settings.planMode = mode === 'plan'
    else if (typeof params.planMode === 'boolean') settings.planMode = params.planMode
    if (params.historyMode != null) {
      if (params.historyMode !== 'legacy' && params.historyMode !== 'paginated')
        throw new ProtocolError(-32602, 'historyMode 无效')
      settings.historyMode = params.historyMode
    }
    if (params.dynamicTools != null) {
      if (!Array.isArray(params.dynamicTools))
        throw new ProtocolError(-32602, 'dynamicTools 必须是数组')
      settings.dynamicTools = params.dynamicTools
    }
    if (params.config != null) settings.config = asRecord(params.config)
    this.store.saveThreadSettings(threadId, settings)
  }

  private threadTurnItemsList(params: Record<string, unknown>): unknown {
    const turnId = stringOr(params.turnId, '')
    const turn = this.store.getTurn(turnId)
    return {
      data: turn?.items ?? [],
      nextCursor: null,
      backwardsCursor: null,
    }
  }

  private threadNameSet(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
    const name = params.name == null ? null : String(params.name)
    this.store.updateThreadName(threadId, name)
    this.notifyThread(threadId, {
      method: 'thread/name/updated',
      params: { threadId, threadName: name ?? undefined },
    })
    return {}
  }

  private threadArchive(params: Record<string, unknown>, archived: boolean): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
    this.store.setArchived(threadId, archived)
    this.notifyThread(threadId, {
      method: archived ? 'thread/archived' : 'thread/unarchived',
      params: { threadId },
    })
    if (!archived) {
      const thread = this.store.getThread(threadId)
      if (!thread) throw new Error(`unknown thread: ${threadId}`)
      return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
    }
    this.clearThreadState(threadId)
    return {}
  }

  // Drops per-thread in-memory state (session-scoped command approvals,
  // elicitation counts) so an archived thread does not
  // leak entries for the lifetime of the process.
  private clearThreadState(threadId: string): void {
    this.commandSessionAllow.delete(threadId)
    this.elicitationCounts.delete(threadId)
  }

  private threadUnsubscribe(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const active = this.activePeerByThread.get(threadId)
    if (!active) return { status: 'notSubscribed' }
    if (active.id !== peer.id) return { status: 'notSubscribed' }
    this.activePeerByThread.delete(threadId)
    this.notify(peer, { method: 'thread/closed', params: { threadId } })
    return { status: 'unsubscribed' }
  }

  private threadLoadedList(params: Record<string, unknown>): unknown {
    const loaded = Array.from(this.activePeerByThread.keys()).sort()
    const { data, nextCursor } = pageRecords(
      loaded,
      { ...params, sortDirection: 'asc' },
      'loaded-threads',
      (id) => id,
    )
    return { data, nextCursor }
  }

  // Codex App calls thread/inject_items to push hidden context into a thread's
  // model history — typically file-attachment ingestion, "pin this output as
  // future context", or App-side memory consolidation. Items are raw Responses
  // API entries (free-form JSON). Without an implementation the App's
  // ingestion just disappears, breaking any feature that relies on it.
  //
  // Approach: synthesize an injected turn carrying a single agentMessage that
  // recaps the items as a human-readable block. That turn becomes part of the
  // thread's transcript so the next runRuntimeTurn picks it up as prior
  // conversation context, AND it's visible in thread/read so the user can
  // confirm what was added. We pick agentMessage (instead of a custom type)
  // for App-compatibility — every Codex App build renders it without needing
  // a new ThreadItem variant.
  private threadInjectItems(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    const items = Array.isArray(params.items) ? params.items : []
    if (items.length === 0) return {}

    const now = nowSeconds()
    const turnId = newId()
    const itemId = newId()
    // Compact summary of injected items — try to extract human-readable text
    // (Responses items often have `content` arrays with text segments).
    const summary = items
      .map((raw) => summarizeInjectedItem(raw))
      .filter(Boolean)
      .join('\n\n')
    const text =
      summary.length > 0
        ? summary
        : `[adapter] ${items.length} item(s) injected via thread/inject_items`
    const agentItem: ThreadItem = {
      type: 'agentMessage',
      id: itemId,
      text,
      phase: null,
      memoryCitation: null,
    }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      items: [agentItem],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    thread.updatedAt = now
    this.store.upsertThread(thread)
    // Defer notifications past the inject_items response. Firing them
    // synchronously enqueues them in front of the response on the wire,
    // which trips clients that do "await response, then read notifications"
    // (they end up draining the notifications while waiting for the
    // response, then loop forever looking for already-discarded events).
    queueMicrotask(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId, turnId, item: agentItem, completedAtMs: nowMillis() },
      })
      this.notify(peer, {
        method: 'turn/completed',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
    })
    debugLog('thread.inject_items', { threadId, count: items.length })
    return {}
  }

  private threadGoalSet(params: Record<string, unknown>): unknown {
    const threadId = this.goalThreadID(params)
    const goal = patchThreadGoal(threadId, this.store.threadGoal(threadId), params)
    this.store.saveThreadGoal(goal)
    setImmediate(() =>
      this.notifyThread(threadId, { method: 'thread/goal/updated', params: { threadId, goal } }),
    )
    return { goal }
  }

  private threadGoalGet(params: Record<string, unknown>): unknown {
    return { goal: this.store.threadGoal(this.goalThreadID(params)) }
  }

  private threadGoalClear(params: Record<string, unknown>): unknown {
    const threadId = this.goalThreadID(params)
    const cleared = this.store.clearThreadGoal(threadId)
    if (cleared)
      setImmediate(() =>
        this.notifyThread(threadId, { method: 'thread/goal/cleared', params: { threadId } }),
      )
    return { cleared }
  }

  private goalThreadID(params: Record<string, unknown>): string {
    const threadId = requiredString(params.threadId, 'threadId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '未知会话')
    return threadId
  }

  private threadAdjustElicitation(params: Record<string, unknown>, delta: number): unknown {
    const threadId = stringOr(params.threadId, '')
    const next = Math.max(0, (this.elicitationCounts.get(threadId) ?? 0) + delta)
    this.elicitationCounts.set(threadId, next)
    return { count: next, paused: next > 0 }
  }

  private threadMetadataUpdate(params: Record<string, unknown>): unknown {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new ProtocolError(-32602, '未知会话')
    const settings = this.store.threadSettings(threadId)
    const gitInfo = patchGitInfo(settings.gitInfo, params.gitInfo)

    // 元数据更新也必须保存完整权限策略，不能只修改展示档位。
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    const reasoningEffort = reasoningEffortFromParams(params, null)
    if (model) {
      const newBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      thread.runtimeBackend = newBackend
      thread.model = model
    }
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    if (permissionProfileId) thread.permissionProfileId = permissionProfileId
    else if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
    if (permissionProfile?.approvalPolicy) thread.approvalPolicy = permissionProfile.approvalPolicy
    if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    if (params.approvalPolicy != null)
      thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
    const sandboxMode = sandboxFromTurnParams(params)
    if (sandboxMode && !permissionProfile) thread.sandboxMode = sandboxMode
    if (typeof params.isPinned === 'boolean') {
      const currentlyPinned = thread.sectionId === PINNED_SECTION_ID || thread.isPinned === true
      if (currentlyPinned !== params.isPinned) {
        const moved = this.store.moveThreadToSection(
          threadId,
          params.isPinned ? PINNED_SECTION_ID : null,
          null,
        )
        thread.isPinned = moved.isPinned
        thread.sectionId = moved.sectionId
        thread.sectionEnteredAt = moved.sectionEnteredAt
        thread.sectionPosition = moved.sectionPosition
      }
    }
    if (typeof params.baseInstructions === 'string')
      thread.baseInstructions = nullIfEmpty(params.baseInstructions)
    if (typeof params.developerInstructions === 'string')
      thread.developerInstructions = nullIfEmpty(params.developerInstructions)
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)

    thread.updatedAt = nowSeconds()
    this.store.upsertThread(thread)
    if (Object.hasOwn(params, 'gitInfo')) {
      settings.gitInfo = gitInfo ?? null
      this.store.saveThreadSettings(threadId, settings)
    }
    this.saveRuntimeSettings(threadId, params)

    return this.threadEnvelope(thread, this.store.listTurns(threadId))
  }

  private threadSettingsUpdate(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)

    // Codex App sends model and effort changes through this RPC. Keep these
    // legacy settings fields in the compatibility handler so removing the
    // duplicate dispatch case does not silently disable profile/model
    // switching for existing clients.
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    if (model) {
      thread.runtimeBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      thread.model = model
    }
    const reasoningEffort = reasoningEffortFromParams(params, null)
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)
    const collaborationMode = asRecord(params.collaborationMode)
    const collaborationSettings = asRecord(collaborationMode.settings)
    const developerInstructions =
      typeof collaborationSettings.developer_instructions === 'string'
        ? collaborationSettings.developer_instructions
        : typeof collaborationSettings.developerInstructions === 'string'
          ? collaborationSettings.developerInstructions
          : null
    if (developerInstructions !== null)
      thread.developerInstructions = nullIfEmpty(developerInstructions)

    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    if (permissionProfileId) thread.permissionProfileId = permissionProfileId
    else if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
    if (permissionProfile?.approvalPolicy) thread.approvalPolicy = permissionProfile.approvalPolicy
    if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    if (params.approvalPolicy != null)
      thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
    const sandboxMode = sandboxFromTurnParams(params)
    if (sandboxMode && !permissionProfile) thread.sandboxMode = sandboxMode
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    this.store.upsertThread(thread)
    this.saveRuntimeSettings(threadId, params)

    const activePermissionProfileId = threadPermissionProfileId(
      thread.permissionProfileId,
      thread.approvalPolicy,
      thread.sandboxMode,
    )
    this.notify(peer, {
      method: 'thread/settings/updated',
      params: {
        threadId,
        threadSettings: {
          cwd: thread.cwd,
          approvalPolicy: thread.approvalPolicy ?? 'on-request',
          approvalsReviewer: 'user',
          sandboxPolicy:
            this.store.threadSettings(threadId).sandboxPolicy ??
            sandboxEnvelope(thread.sandboxMode, thread.cwd),
          activePermissionProfile: activePermissionProfileId
            ? { id: activePermissionProfileId, extends: null }
            : null,
          model: thread.model,
          modelProvider: thread.modelProvider,
          serviceTier: null,
          effort: thread.reasoningEffort,
          summary: null,
          collaborationMode: {
            mode: this.store.threadSettings(threadId).planMode ? 'plan' : 'default',
            settings: {
              model: thread.model,
              reasoning_effort: thread.reasoningEffort,
              developer_instructions: thread.developerInstructions,
            },
          },
          personality: thread.personality,
        },
      },
    })
    return {}
  }

  private async forkNativeSession(thread: ThreadRecord, boundary?: string): Promise<string> {
    if (!this.runtime.forkSession || !thread.claudeSessionId)
      throw new ProtocolError(-32000, '缺少原生会话或分叉能力')
    return this.runtime.forkSession(thread.claudeSessionId, thread.cwd, boundary)
  }

  private async threadRollback(params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    if (this.activeTurnByThread.has(threadId)) throw new ProtocolError(-32009, '活动会话不能回退')
    // Honor the protocol's `numTurns: u32, must be >= 1` — drop that many
    // turns from the end of the thread. Without this, App's rewind UI sends
    // the request and we silently return the unchanged thread, leaving the
    // user staring at the timeline they were trying to redo.
    const numTurns = params.numTurns
    if (typeof numTurns !== 'number' || !Number.isInteger(numTurns) || numTurns < 1)
      throw new ProtocolError(-32602, 'numTurns 必须是正整数')
    const retained = this.store.listTurns(threadId).slice(0, -numTurns)
    if (thread.claudeSessionId && retained.length) {
      const boundary = this.store.nativeBoundary(retained.at(-1)!.id)
      if (!boundary) throw new ProtocolError(-32000, '缺少原生消息边界，不能安全回退')
      thread.claudeSessionId = await this.forkNativeSession(thread, boundary)
    } else thread.claudeSessionId = null
    const dropped = this.store.commitRollback(thread, numTurns)
    debugLog('thread.rollback', { threadId, requested: numTurns, dropped })
    return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
  }

  private threadShellCommand(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    const command = stringOr(params.command, '')
    if (!command) return {}
    const shell = process.env.SHELL || '/bin/sh'
    const cwd = thread?.cwd ?? process.cwd()
    const processId = newId()
    debugLog('thread.shellCommand.start', { threadId, processId, cwd, command })
    const child = spawn(shell, ['-lc', command], { cwd, env: process.env, stdio: 'pipe' })
    this.commandProcesses.set(processId, child)
    child.stdout?.on('data', (chunk) =>
      this.notify(peer, {
        method: 'command/exec/outputDelta',
        params: {
          processId,
          stream: 'stdout',
          deltaBase64: Buffer.from(chunk).toString('base64'),
          capReached: false,
        },
      }),
    )
    child.stderr?.on('data', (chunk) =>
      this.notify(peer, {
        method: 'command/exec/outputDelta',
        params: {
          processId,
          stream: 'stderr',
          deltaBase64: Buffer.from(chunk).toString('base64'),
          capReached: false,
        },
      }),
    )
    child.once('error', (error) =>
      debugLog('thread.shellCommand.error', { threadId, processId, error: error.message }),
    )
    child.once('close', (code, signal) => {
      debugLog('thread.shellCommand.close', { threadId, processId, code, signal })
      this.commandProcesses.delete(processId)
    })
    return {}
  }

  private threadBackgroundTerminalsClean(params: Record<string, unknown>): unknown {
    debugLog('thread.backgroundTerminals.clean', {
      threadId: stringOr(params.threadId, ''),
      activeCommandProcesses: this.commandProcesses.size,
      activeProcessHandles: this.processes.activeCount,
    })
    return {}
  }

  private reviewStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    this.activePeerByThread.set(threadId, peer)
    const turnId = newId()
    const review = reviewLabel(params.target)
    const prompt = reviewPrompt(params.target)
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: turnId,
      content: [{ type: 'text', text: review, text_elements: [] }],
    }
    const entered: ThreadItem = { type: 'enteredReviewMode', id: newId(), review }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [userItem, entered],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
    this.markActiveTurn(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    // The review/start RESPONSE carries the synthesized userMessage item (the
    // real app-server's build_review_turn does the same, with itemsView
    // notLoaded); the turn/started NOTIFICATION stays empty like every other
    // lifecycle turn.
    const responseTurn = this.toLifecycleTurn(turn, [userItem])
    setImmediate(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: entered, startedAtMs: nowMillis() },
      })
      void this.runRuntimeTurn(peer, thread, turn, prompt, {
        model: thread.model,
        effort: thread.reasoningEffort,
      }).catch((error) => {
        const completed =
          this.store.completeTurn(turnId, 'failed', { message: error.message }) ?? turn
        this.pendingInteractions.cancelThread(threadId)
        recordRunEvent('turn.failed', {
          threadId,
          turnId,
          runtimeBackend: thread.runtimeBackend,
          error: { message: error.message },
        })
        this.notify(peer, {
          method: 'error',
          params: { threadId, turnId, willRetry: false, error: { message: error.message } },
        })
        this.notify(peer, {
          method: 'turn/completed',
          params: { threadId, turn: this.toLifecycleTurn(completed) },
        })
        this.clearActiveTurn(threadId)
        this.setThreadStatus(peer, threadId, { type: 'idle' })
      })
    })
    return { turn: responseTurn, reviewThreadId: threadId }
  }

  private threadCompactStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    if (this.activeTurnByThread.has(threadId)) throw new ProtocolError(-32009, '活动会话不能压缩')
    const turnId = newId()
    const compactItem: ThreadItem = { type: 'contextCompaction', id: newId() }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [compactItem],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
    this.markActiveTurn(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    setImmediate(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: compactItem, startedAtMs: nowMillis() },
      })
      const agentItem: ThreadItem = {
        type: 'agentMessage',
        id: newId(),
        text: '',
        phase: null,
        memoryCitation: null,
      }
      this.store.appendItem(turnId, agentItem)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: agentItem, startedAtMs: nowMillis() },
      })

      let failure: Error | null = null
      void this.runCompactTurn(peer, thread, turnId, agentItem.id, compactItem)
        .catch((error) => {
          failure = error instanceof Error ? error : new Error(String(error))
        })
        .finally(() => {
          if (this.stopped) return
          this.notify(peer, {
            method: 'item/completed',
            params: { threadId, turnId, item: compactItem, completedAtMs: nowMillis() },
          })
          const finalAgent =
            this.store.getTurn(turnId)?.items.find((i) => i.id === agentItem.id) ?? agentItem
          this.notify(peer, {
            method: 'item/completed',
            params: { threadId, turnId, item: finalAgent, completedAtMs: nowMillis() },
          })
          const completed =
            this.store.completeTurn(
              turnId,
              failure ? 'failed' : 'completed',
              failure ? { message: failure.message } : null,
            ) ?? turn
          this.clearActiveTurn(threadId)
          this.setThreadStatus(peer, threadId, { type: 'idle' })
          this.notify(peer, {
            method: 'turn/completed',
            params: { threadId, turn: this.toLifecycleTurn(completed) },
          })
          if (!failure)
            this.notify(peer, { method: 'thread/compacted', params: { threadId, turnId } })
        })
    })
    return {}
  }

  // Calls into the runtime with a structured "give me a 1-paragraph summary"
  // prompt against the summary model alias (haiku). Streams the text into the
  // placeholder agent message via item/agentMessage/delta. Errors propagate
  // so the threadCompactStart fallback can substitute the local snippet.
  private async runCompactTurn(
    peer: RpcPeer,
    thread: ThreadRecord,
    turnId: string,
    agentItemId: string,
    compactItem: ThreadItem,
  ): Promise<void> {
    let compacted = false
    await this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId,
        purpose: 'compact',
        prompt: '/compact',
        cwd: thread.cwd,
        runtimeType: null,
        model: resolveClaudeModel(thread.model, 'normal'),
        effort: resolveClaudeEffort(thread.reasoningEffort ?? null),
        claudeSessionId: thread.claudeSessionId,
        forkSession: false,
        mcpServers: null,
        allowedTools: ['Read', 'Glob', 'Grep'],
        addDirs: [],
        enableFileCheckpointing: false,
        outputFormat: null,
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: async (event) => {
          if (this.stopped) return
          if (event.type === 'context_compacted') {
            compacted = true
            if (event.messageId) this.store.saveNativeBoundary(turnId, event.messageId)
          }
          if (event.type === 'text_delta' && event.delta) {
            this.store.updateItem(turnId, agentItemId, (item) =>
              item.type === 'agentMessage' ? { ...item, text: item.text + event.delta } : item,
            )
            this.notify(peer, {
              method: 'item/agentMessage/delta',
              params: { threadId: thread.id, turnId, itemId: agentItemId, delta: event.delta },
            })
          }
          if (event.type === 'error') throw new Error(event.message)
          if (event.type === 'completed' && !event.success) {
            throw new Error(event.result ?? 'compaction turn failed')
          }
        },
        // Compaction never asks for approvals — it's read-only summarisation.
        onPermissionRequest: async () => ({ decision: 'accept' }),
        // Compaction shouldn't ever invoke AskUserQuestion; if it does, return
        // an empty answer so the model proceeds with its summary.
        onUserInputRequest: async (event) => ({
          answers: Object.fromEntries(event.questions.map((q) => [q.id, { answers: [] }])),
        }),
      },
    )

    if (!compacted) {
      void compactItem
      throw new Error('未收到原生压缩边界，不能确认上下文已压缩')
    }
  }

  private async turnStart(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    const messageId =
      params.clientUserMessageId == null
        ? null
        : requiredString(params.clientUserMessageId, 'clientUserMessageId')
    const hash = submissionHash(params)
    if (messageId) {
      const submitted = this.store.submittedTurn(threadId, messageId, hash)
      if (submitted) return { turn: this.toLifecycleTurn(submitted) }
    }
    if (
      this.activeTurnByThread.has(threadId) ||
      this.interruptingByThread.has(threadId) ||
      this.store.listTurns(threadId).some((turn) => turn.status === 'inProgress')
    )
      throw new ProtocolError(-32009, '会话已有活动或结果尚未确认的 Turn')
    this.activePeerByThread.set(threadId, peer)

    const turnId = newId()
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    // extractImageInputs splits user input into the text prompt and any image
    // attachments (localImage / image URL / data:). Sidecar repacks the
    // images into a Claude SDK multimodal user message; here we also append
    // an `imageView` ThreadItem per image so the App's transcript shows them
    // inline next to the user message instead of losing them.
    const { textPrompt, images } = extractImageInputs(input)
    const prompt = textPrompt || textFromInput(input)
    const workflowCommand = parseWorkflowCommand(prompt)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    const model = modelFromParams(params, thread.model)
    const reasoningEffort = reasoningEffortFromParams(params, thread.reasoningEffort)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    if (model) thread.model = model
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (permissionProfileId) {
      thread.permissionProfileId = permissionProfileId
      if (params.approvalPolicy != null)
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      else if (permissionProfile?.approvalPolicy)
        thread.approvalPolicy = permissionProfile.approvalPolicy
      if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    } else {
      if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
      if (params.approvalPolicy != null)
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      const requestedSandbox = sandboxFromTurnParams(params)
      if (requestedSandbox) thread.sandboxMode = requestedSandbox
    }
    this.store.upsertThread(thread)
    if (!thread.preview && prompt) {
      thread.preview = prompt.slice(0, 200)
      thread.updatedAt = nowSeconds()
      this.store.upsertThread(thread)
    }
    const initialItems: ThreadItem[] = [
      { type: 'userMessage', id: newId(), content: input, clientId: messageId },
    ]
    const imageItems: ThreadItem[] = []
    for (const img of images) {
      // Codex v2 imageView.path is AbsolutePathBuf — Rust's custom Deserialize
      // rejects anything that isn't an absolute filesystem path (URLs, data:
      // URIs, relative paths). For non-local images we'd otherwise crash the
      // App on persist/reload. Only emit imageView for kind:'base64' inputs
      // that came from a real local file path (the displayPath in that case
      // is the original absolute path captured by extractImageInputs).
      if (img.kind === 'base64' && img.displayPath.startsWith('/')) {
        imageItems.push({ type: 'imageView', id: newId(), path: img.displayPath })
      }
    }
    // imageView items are retained on the turn for history (thread/read) and, in
    // contrast to the userMessage, surfaced live through the item/* event stream
    // so the App's transcript shows the uploaded image inline during the turn.
    initialItems.push(...imageItems)
    // Note: we used to short-circuit Codex App's title-generation turn with a
    // local regex-derived title to avoid prompt leakage into the parent thread.
    // That leakage no longer happens (title turns run on their own ephemeral
    // thread, filtered from listings), so the short-circuit was just forcing a
    // hardcoded "处理X" string instead of the real model output. Now every turn
    // — including the structured title turn on Claude Haiku — runs end-to-end.
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: initialItems,
      diff: '',
      error: null,
    }
    this.store.saveSubmission(turn, messageId, hash)
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
    this.markActiveTurn(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    const publicTurn = this.toLifecycleTurn(turn)

    setImmediate(() => {
      this.notify(peer, { method: 'turn/started', params: { threadId, turn: publicTurn } })
      for (const item of imageItems) {
        this.notify(peer, {
          method: 'item/started',
          params: { threadId, turnId, item, startedAtMs: nowMillis() },
        })
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId, turnId, item, completedAtMs: nowMillis() },
        })
      }
      if (params.outputSchema == null && workflowCommand?.type === 'list') {
        this.completeWorkflowListTurn(peer, thread, turn)
        return
      }
      // Carry parsed images through the params bag so runRuntimeTurn can hand
      // them to the runtime context without re-parsing user input.
      void this.runRuntimeTurn(peer, thread, turn, prompt, {
        ...params,
        _imageInputs: images,
      }).catch((error) => {
        if (this.stopped) return
        const current = this.store.getTurn(turnId)
        if (current && current.status !== 'inProgress') return
        const completed =
          this.store.completeTurn(turnId, 'failed', { message: error.message }) ?? turn
        this.pendingInteractions.cancelThread(threadId)
        this.notify(peer, {
          method: 'error',
          params: { threadId, turnId, willRetry: false, error: { message: error.message } },
        })
        this.notify(peer, {
          method: 'turn/completed',
          params: { threadId, turn: this.toLifecycleTurn(completed) },
        })
        this.clearActiveTurn(threadId)
        this.setThreadStatus(peer, threadId, { type: 'idle' })
      })
    })
    return { turn: publicTurn }
  }

  private completeWorkflowListTurn(peer: RpcPeer, thread: ThreadRecord, turn: TurnRecord): void {
    const itemId = newId()
    const emptyItem: ThreadItem = {
      type: 'agentMessage',
      id: itemId,
      text: '',
      phase: null,
      memoryCitation: null,
    }
    this.store.appendItem(turn.id, emptyItem)
    this.notify(peer, {
      method: 'item/started',
      params: { threadId: thread.id, turnId: turn.id, item: emptyItem, startedAtMs: nowMillis() },
    })

    const text = this.workflowListText(thread.id, turn.id)
    const completedItem: ThreadItem = { ...emptyItem, text }
    this.store.updateItem(turn.id, itemId, () => completedItem)
    this.notify(peer, {
      method: 'item/agentMessage/delta',
      params: { threadId: thread.id, turnId: turn.id, itemId, delta: text },
    })
    this.notify(peer, {
      method: 'item/completed',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        item: completedItem,
        completedAtMs: nowMillis(),
      },
    })

    const completed = this.store.completeTurn(turn.id, 'completed') ?? turn
    recordRunEvent('turn.completed', {
      threadId: thread.id,
      turnId: turn.id,
      runtimeBackend: thread.runtimeBackend,
      durationMs: completed.durationMs,
      command: 'workflows.list',
    })
    this.clearActiveTurn(thread.id)
    this.setThreadStatus(peer, thread.id, { type: 'idle' })
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId: thread.id, turn: this.toLifecycleTurn(completed) },
    })
  }

  private workflowListText(threadId: string, currentTurnId: string): string {
    const runs = this.store
      .listTurns(threadId)
      .filter((turn) => turn.id !== currentTurnId)
      .map((turn) => {
        const userItem = turn.items.find((item) => item.type === 'userMessage')
        const prompt = userItem?.type === 'userMessage' ? textFromInput(userItem.content) : ''
        const command = parseWorkflowCommand(prompt)
        if (command?.type !== 'run') return null
        const childIds = new Set<string>()
        for (const item of turn.items) {
          if (item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') continue
          for (const childId of item.receiverThreadIds) childIds.add(childId)
        }
        const agents = Array.from(childIds).map((childId) => {
          const child = this.store.getThread(childId)
          const latestTurn = this.store.listTurns(childId).at(-1)
          return {
            nickname: child?.agentNickname ?? childId.slice(0, 12),
            role: child?.agentRole ?? 'subagent',
            status: latestTurn?.status ?? child?.status.type ?? 'unknown',
          }
        })
        return { turn, prompt: command.prompt, agents }
      })
      .filter((run): run is NonNullable<typeof run> => run !== null)
      .reverse()
      .slice(0, 20)

    if (runs.length === 0) {
      return [
        'No workflow runs in this task.',
        '',
        'Start one with `/workflows <task>`. The adapter runs it through Claude ultracode and exposes its agents as reviewable Codex subagent tasks.',
      ].join('\n')
    }

    const lines = ['Workflow runs in this task:']
    for (const run of runs) {
      const task = run.prompt.replace(/\s+/g, ' ').slice(0, 120)
      lines.push(
        `- ${run.turn.id.slice(0, 12)} · ${run.turn.status} · ${run.agents.length} agent(s) · ${task}`,
      )
      if (run.agents.length > 0) {
        lines.push(
          `  Agents: ${run.agents
            .map((agent) => `${agent.nickname} (${agent.role}, ${agent.status})`)
            .join(', ')}`,
        )
      }
    }
    lines.push('', 'Open the Agent items in the workflow turn to review each child task.')
    return lines.join('\n')
  }

  private async runRuntimeTurn(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    prompt: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const itemIds = new Map<string, string>()
    let agentItemId: string | null = null
    let reasoningItemId: string | null = null
    let hasTextOutput = false
    const noticesSeen = new Set<string>()
    const commandOutputSeen = new Set<string>()
    // MultiAgent V2 uses subAgentActivity for display/liveness and the
    // spawnAgent/wait tool calls for the structured timeline. A naturally
    // completed child is not closed again: wait/completed must remain the last
    // parent state so Codex App retains the terminal snapshot.
    const subagentContexts = new Map<string, SubagentContext>()
    const activeSubagents = new Set<string>()
    // A Workflow launch can be pending before it has produced a journal
    // agent (or after its last projected agent has completed). Keep the
    // watchdog armed for that whole async operation, not only while a child
    // tool_use is present.
    let workflowInFlight = false
    const workflowLaunchToolUseIds = new Set<string>()
    // Track per-item start time so commandExecution / mcpToolCall items can
    // report a real durationMs in turn/completed (otherwise the App's status
    // bar shows "—" for every command).
    const itemStartedAtMs = new Map<string, number>()
    // Mutable holder rather than `let collectedMetrics`: TS's control-flow
    // analysis doesn't see writes from inside the onEvent callback, so a bare
    // `let` would still be inferred as `null` outside the closure.
    const collectedMetrics: {
      apiDurationMs: number | null
      numTurns: number | null
      costUsd: number | null
      set: boolean
    } = {
      apiDurationMs: null,
      numTurns: null,
      costUsd: null,
      set: false,
    }
    const forkSession = false
    // Plan mode: Claude SDK runs with permissionMode='plan' — it produces
    // planning text but does not execute tools. We surface the planning
    // output as Codex's native `plan` ThreadItem (instead of agentMessage)
    // and stream deltas via item/plan/delta + turn/plan/updated so the
    // App's Plan-mode UI lights up properly. Detection:
    //   * turn/start.planMode === true (App's explicit request)
    //   * thread.approvalPolicy / sandbox flags don't suppress it
    // The current planMode flag for this turn was computed above as
    // `params.planMode === true`; reproduce here so the helpers can check it.
    this.saveRuntimeSettings(thread.id, params)
    let planMode = this.store.threadSettings(thread.id).planMode === true
    let planItemId: string | null = null
    const ensurePlanItem = (): string => {
      if (planItemId) return planItemId
      planItemId = newId()
      const item: ThreadItem = { type: 'plan', id: planItemId, text: '' }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return planItemId
    }
    const ensureAgentItem = (): string => {
      if (agentItemId) return agentItemId
      agentItemId = newId()
      const item: ThreadItem = {
        type: 'agentMessage',
        id: agentItemId,
        text: '',
        phase: null,
        memoryCitation: null,
      }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return agentItemId
    }
    const ensureReasoningItem = (): string => {
      if (reasoningItemId) return reasoningItemId
      reasoningItemId = newId()
      const item: ThreadItem = {
        type: 'reasoning',
        id: reasoningItemId,
        summary: [],
        content: [''],
      }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return reasoningItemId
    }
    const completeReasoningItem = (): void => {
      if (!reasoningItemId) return
      const item = this.store.getTurn(turn.id)?.items.find((item) => item.id === reasoningItemId)
      if (item)
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
        })
      reasoningItemId = null
    }
    const completeAgentItem = (phase: 'commentary' | 'final_answer'): void => {
      if (!agentItemId) return
      const updated = this.store.updateItem(turn.id, agentItemId, (item) =>
        item.type === 'agentMessage' ? { ...item, phase } : item,
      )
      const item = updated?.items.find((item) => item.id === agentItemId)
      if (item)
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
        })
      agentItemId = null
    }
    const completeMessage = (phase: 'commentary' | 'final_answer' = 'commentary'): void => {
      completeReasoningItem()
      completeAgentItem(phase)
    }

    // Allow per-turn override of policy (Codex App may attach updated values
    // when the user toggles Full access mid-conversation), then fall back to
    // the thread-level setting captured at start/resume. turn/start ships a
    // sandboxPolicy struct (e.g. {type:"dangerFullAccess"}); thread/start uses
    // the simpler sandbox string. Both are honoured.
    const permissionProfile = permissionProfilePolicy(permissionProfileIdFromParams(params))
    const approvalPolicy =
      (params.approvalPolicy != null ? normalizeApprovalPolicy(params.approvalPolicy) : null) ??
      permissionProfile?.approvalPolicy ??
      thread.approvalPolicy
    const sandboxMode =
      permissionProfile?.sandboxMode ?? sandboxFromTurnParams(params) ?? thread.sandboxMode
    // Per-turn instruction overrides: Codex App may resend its instruction
    // panel state when the user toggles personality mid-thread. Falls back to
    // whatever was captured at thread/start.
    const baseInstructions =
      (typeof params.baseInstructions === 'string' ? params.baseInstructions : null) ??
      thread.baseInstructions
    const developerInstructions =
      (typeof params.developerInstructions === 'string' ? params.developerInstructions : null) ??
      thread.developerInstructions
    const personality =
      (typeof params.personality === 'string' ? normalizePersonality(params.personality) : null) ??
      thread.personality
    const turnPurpose = params.outputSchema == null ? 'normal' : 'summary'
    const desktopPresentation = turnPurpose === 'normal' && thread.runtimeBackend !== 'codex'
    // If this is a forked side-conversation (sidechat) that has different
    // developerInstructions from its parent, appending them to systemPromptAddendum
    // would mutate the system prompt prefix and invalidate the prefix KV cache
    // for all inherited history (80k+ tokens).
    // Instead, preserve the parent's system prompt addendum to guarantee 100% cache hits,
    // and prepend side-conversation instructions directly into the turn's user prompt.
    let systemPromptAddendum: string | null = null
    let effectivePrompt = prompt
    if (thread.forkedFromId != null && developerInstructions) {
      const parentThread = this.store.getThread(thread.forkedFromId)
      const parentDev = parentThread?.developerInstructions ?? null
      if (developerInstructions !== parentDev) {
        systemPromptAddendum = buildSystemPromptAddendum({
          baseInstructions: parentThread?.baseInstructions ?? baseInstructions,
          developerInstructions: parentDev,
          personality: parentThread?.personality ?? personality,
          desktopPresentation,
        })
        effectivePrompt = `<side-conversation-instructions>\n${developerInstructions}\n</side-conversation-instructions>\n\n${prompt}`
      } else {
        systemPromptAddendum = buildSystemPromptAddendum({
          baseInstructions,
          developerInstructions,
          personality,
          desktopPresentation,
        })
      }
    } else {
      systemPromptAddendum = buildSystemPromptAddendum({
        baseInstructions,
        developerInstructions,
        personality,
        desktopPresentation,
      })
    }

    const rawTurnModel = stringOr(params.model, thread.model)
    const isCodexThread = false
    const resolvedModel = isCodexThread
      ? rawTurnModel
      : resolveClaudeModel(rawTurnModel, params.outputSchema == null ? 'normal' : 'summary')
    const resolvedEffort = resolveClaudeEffort(
      typeof params.effort === 'string'
        ? params.effort
        : (thread.reasoningEffort ?? process.env.CLAUDE_CODEX_EFFORT ?? null),
    )
    // Log the effective Claude SDK model+effort per turn so when a user
    // reports "switching model didn't work" we can diff App's payload against
    // what actually reached the SDK in one grep.
    debugLog('turn.runtime.applied', {
      threadId: thread.id,
      turnId: turn.id,
      paramsModel: params.model ?? null,
      paramsEffort: params.effort ?? null,
      threadModel: thread.model,
      threadEffort: thread.reasoningEffort,
      envDefaultModel: process.env.CLAUDE_CODEX_DEFAULT_MODEL ?? null,
      envDefaultEffort:
        process.env.CLAUDE_CODEX_DEFAULT_EFFORT ?? process.env.CLAUDE_CODEX_EFFORT ?? null,
      resolvedModel,
      resolvedEffort,
    })
    // For codex-backed threads, force the per-turn runtimeType to 'codex-proxy'
    // so the SelectableRuntime dispatches to CodexProxyRuntime instead of
    // the default Claude SDK runtime. Also route the codex session id (stored
    // separately from Claude's) through the existing claudeSessionId slot —
    // CodexProxyRuntime consumes it as the resume id. In mock mode the
    // mock runtime handles everything regardless of model id — bypass the
    // codex-proxy override so unit tests stay deterministic.
    this.subagentStateByTurn.set(turn.id, {
      thread,
      turn,
      contexts: subagentContexts,
      active: activeSubagents,
    })
    let acceptRuntimeEvents = true
    let watchdogTimer: NodeJS.Timeout | null = null
    let resolveWatchdog: (() => void) | null = null
    const watchdogTimeoutMs = subagentWatchdogTimeoutMs()
    const watchdogPromise =
      watchdogTimeoutMs > 0
        ? new Promise<void>((resolve) => {
            resolveWatchdog = resolve
          })
        : null
    const disarmWatchdog = (): void => {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    const armWatchdog = (): void => {
      if (
        !watchdogPromise ||
        watchdogTimer ||
        !acceptRuntimeEvents ||
        (activeSubagents.size === 0 && !workflowInFlight)
      )
        return
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null
        // Flip this before resolving the race so an already-buffered SDK event
        // cannot create a fresh child after the watchdog has decided to fail.
        acceptRuntimeEvents = false
        resolveWatchdog?.()
      }, watchdogTimeoutMs)
      watchdogTimer.unref()
    }
    const turnIsActive = (): boolean =>
      !this.stopped &&
      acceptRuntimeEvents &&
      this.store.getTurn(turn.id)?.status === 'inProgress' &&
      this.activeTurnByThread.get(thread.id) === turn.id
    if (!turnIsActive()) return
    this.runtimeReadyByTurn.get(turn.id)?.resolve(true)
    const runtimeTurn = this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId: turn.id,
        purpose: turnPurpose,
        prompt: effectivePrompt,
        cwd: stringOr(params.cwd, thread.cwd),
        runtimeType: isCodexThread ? 'codex-proxy' : null,
        model: resolvedModel,
        effort: resolvedEffort,
        claudeSessionId: isCodexThread ? thread.codexSessionId : thread.claudeSessionId,
        forkSession,
        mcpServers: this.mcpScope(thread.id).servers,
        dynamicTools: this.store.threadSettings(thread.id).dynamicTools ?? [],
        allowedTools: defaultAllowedTools(),
        addDirs: stringListFromEnv('CLAUDE_CODEX_ADD_DIRS', []),
        enableFileCheckpointing: process.env.CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING === '1',
        outputFormat: claudeOutputFormat(params.outputSchema),
        approvalPolicy,
        sandboxMode,
        sandboxPolicy:
          this.store.threadSettings(thread.id).sandboxPolicy ??
          defaultSandboxPolicy(sandboxMode, thread.cwd),
        systemPromptAddendum,
        planMode,
        imageInputs: Array.isArray(params._imageInputs)
          ? (params._imageInputs as ImageInput[])
          : [],
      },
      {
        onDynamicToolCall: async (tool, args, callId) => {
          if (!turnIsActive()) throw new Error('Turn 已结束，不能执行工具')
          const previous = this.store.reserveTool(thread.id, callId, submissionHash({ tool, args }))
          if (previous) return previous.result
          const requestId = newId()
          completeMessage()
          const startedAt = nowMillis()
          const item: Extract<ThreadItem, { type: 'dynamicToolCall' }> = {
            type: 'dynamicToolCall',
            id: callId,
            namespace: tool.namespace ?? null,
            tool: tool.name,
            arguments: args,
            status: 'inProgress',
            contentItems: null,
            success: null,
            durationMs: null,
          }
          this.store.appendItem(turn.id, item)
          itemIds.set(callId, item.id)
          this.notify(peer, {
            method: 'item/started',
            params: {
              threadId: thread.id,
              turnId: turn.id,
              item,
              startedAtMs: startedAt,
            },
          })
          const finish = (result: unknown) => {
            // 保存执行器原始结果，不能用 SDK 为模型截断/落盘后的 tool_result 覆盖 UI 历史。
            if (!turnIsActive()) return
            const output = dynamicToolResult(result)
            const completed: ThreadItem = {
              ...item,
              ...output,
              status: output.success ? 'completed' : 'failed',
              durationMs: nowMillis() - startedAt,
            }
            this.store.updateItem(turn.id, item.id, () => completed)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: completed,
                completedAtMs: nowMillis(),
              },
            })
          }
          try {
            const result = dynamicToolResult(
              await this.sendServerRequest(peer, 'item/tool/call', requestId, {
                threadId: thread.id,
                turnId: turn.id,
                callId,
                tool: tool.name,
                namespace: tool.namespace ?? null,
                arguments: args,
              }),
            )
            this.store.completeTool(thread.id, callId, result)
            finish(result)
            return result
          } catch (error) {
            // 未收到确定结果仍保留执行意图，禁止后续重放副作用。
            finish({ success: false, contentItems: [{ type: 'inputText', text: String(error) }] })
            throw error
          }
        },
        onEvent: async (event) => {
          // Interrupts, watchdog expiry, and a peer reconnect can leave a few
          // SDK messages queued after the server has terminalized the turn.
          // They are stale and must never resurrect a child or an inProgress
          // item in the Codex App.
          if (!turnIsActive()) return
          if (event.type === 'native_boundary') {
            this.store.saveNativeBoundary(turn.id, event.messageId)
            return
          }
          if (event.type === 'session') {
            this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
            return
          }
          if (activeSubagents.size > 0) {
            if (
              event.type === 'text_delta' ||
              event.type === 'reasoning_delta' ||
              event.type === 'message_boundary'
            )
              return
            if (event.type === 'tool_use' && !isSubagentToolName(event.toolName)) return
            if (event.type === 'tool_output_delta' && !itemIds.has(event.toolUseId)) return
            if (
              event.type === 'tool_result' &&
              !activeSubagents.has(event.toolUseId) &&
              !itemIds.has(event.toolUseId)
            )
              return
          }
          if (event.type === 'message_boundary') {
            completeMessage()
            return
          }
          if (event.type === 'tool_use' && !itemIds.has(event.toolUseId)) completeMessage()
          if (event.type === 'tool_use' && isSubagentToolName(event.toolName)) {
            // Spawn the ephemeral child, then mirror MultiAgent V2: a
            // subAgentActivity started item plus spawnAgent/wait tool state.
            //
            // Concept alignment: Claude's `subagent_type` (e.g. "general-
            // purpose") is the same idea as Codex's `agentRole`; we also
            // generate an `agentNickname` matching the `agent-{12hex}` shape
            // Claude itself uses internally so the App's subagent UI shows a
            // distinct, repeatable handle. The collabAgentToolCall.model
            // field carries the actual SDK model the subagent runs on, NOT
            // the subagent_type — that distinction was wrong before.
            const promptText = String(event.input.prompt ?? event.input.description ?? '')
            const subType =
              typeof event.input.subagent_type === 'string' ? event.input.subagent_type : null
            const subagentModel =
              typeof event.input.model === 'string' ? event.input.model : thread.model
            const childThreadId = newId()
            const agentNickname = `agent-${childThreadId.replace(/-/g, '').slice(0, 12)}`
            const agentPath = `/root/${agentNickname}`
            const agentRole = subType ?? 'general-purpose'
            const childStartedAt = nowSeconds()
            const childThread: ThreadRecord = {
              id: childThreadId,
              sessionId: thread.sessionId,
              forkedFromId: thread.id,
              isPinned: false,
              sectionId: null,
              sectionEnteredAt: null,
              sectionPosition: null,
              preview: promptText.slice(0, 200),
              name: null,
              archived: false,
              cwd: thread.cwd,
              model: subagentModel,
              reasoningEffort: thread.reasoningEffort,
              modelProvider: thread.modelProvider,
              claudeSessionId: null,
              source: normalizeSessionSource(thread.source),
              createdAt: childStartedAt,
              updatedAt: childStartedAt,
              status: { type: 'active', activeFlags: [] },
              approvalPolicy: thread.approvalPolicy,
              sandboxMode: thread.sandboxMode,
              ephemeral: true,
              threadSource: 'subagent',
              agentRole,
              agentNickname,
              // Subagent inherits parent's instruction surface so the same
              // project/developer guidance applies to the child run.
              baseInstructions: thread.baseInstructions,
              developerInstructions: thread.developerInstructions,
              personality: thread.personality,
              // Subagents always run via Claude — the Task tool is a Claude SDK
              // construct. A codex-backed thread that spawns a subagent would
              // never reach this code path (subagent detection is Claude-side).
              runtimeBackend: 'claude',
              codexSessionId: null,
            }
            this.store.upsertThread(childThread)
            // Child notifications must follow the current parent peer. This
            // matters after unix-daemon reconnects, when the old peer is gone
            // before the child publishes its response.
            this.activePeerByThread.set(childThreadId, peer)
            const childTurn: TurnRecord = {
              id: newId(),
              threadId: childThreadId,
              status: 'inProgress',
              startedAt: childStartedAt,
              completedAt: null,
              durationMs: null,
              items: [
                {
                  type: 'userMessage',
                  id: newId(),
                  content: [{ type: 'text', text: promptText, text_elements: [] }],
                },
              ],
              diff: '',
              error: null,
            }
            this.store.upsertTurn(childTurn)
            this.notify(peer, {
              method: 'thread/started',
              params: { thread: this.toThread(childThread, []) },
            })
            this.notify(peer, {
              method: 'turn/started',
              params: {
                threadId: childThreadId,
                turn: this.toLifecycleTurn(childTurn),
              },
            })
            // The bundled Codex cc client creates a child conversation from
            // thread/started with an empty turn and treats the history as
            // loaded while the child is live. Replay the persisted prompt as
            // a normal item lifecycle so the child page has its Prompt even
            // when it is opened before the first response token arrives.
            const childPrompt = childTurn.items.find((item) => item.type === 'userMessage')
            if (childPrompt) this.emitItemLifecycle(peer, childThreadId, childTurn.id, childPrompt)
            recordRunEvent('subagent.spawned', {
              parentThreadId: thread.id,
              parentTurnId: turn.id,
              childThreadId,
              model: subagentModel,
              agentRole,
              agentNickname,
            })

            // Stage 1 — spawnAgent (begin + end emitted together; the agent is
            // already created so there's no real latency here).
            const spawnId = newId()
            // Codex v2 collabAgentToolCall.reasoningEffort is `ReasoningEffort | null`
            // (strict enum: none|minimal|low|medium|high|xhigh). Same Oops trap as
            // threadSource — an empty string from a sloppy resume crashes the App.
            // Normalize here once and reuse for every stage of the lifecycle.
            const collabEffort = normalizeReasoningEffortEnum(thread.reasoningEffort)
            const spawnBegin: ThreadItem = {
              type: 'collabAgentToolCall',
              id: spawnId,
              tool: 'spawnAgent',
              status: 'inProgress',
              senderThreadId: thread.id,
              receiverThreadIds: [],
              prompt: promptText || null,
              model: subagentModel,
              reasoningEffort: collabEffort,
              agentsStates: {},
            }
            this.store.appendItem(turn.id, spawnBegin)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: spawnBegin,
                startedAtMs: nowMillis(),
              },
            })
            const spawnEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: spawnId,
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: thread.id,
              receiverThreadIds: [childThreadId],
              prompt: promptText || null,
              model: subagentModel,
              reasoningEffort: collabEffort,
              agentsStates: { [childThreadId]: { status: 'running', message: null } },
            }
            this.store.updateItem(turn.id, spawnId, () => spawnEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: spawnEnd,
                completedAtMs: nowMillis(),
              },
            })
            const waitId = newId()
            const subagentContext: SubagentContext = {
              childThreadId,
              childTurnId: childTurn.id,
              waitItemId: waitId,
              agentPath,
              prompt: promptText,
              subType,
            }
            this.emitSubagentActivity(peer, thread.id, turn.id, subagentContext, 'started')

            // Wait begins after the activity item; this is the long phase that
            // gives Codex App its "agent is working" indicator while the
            // subagent runs. It closes when the Task tool_result arrives.
            const waitBegin: ThreadItem = {
              type: 'collabAgentToolCall',
              id: waitId,
              tool: 'wait',
              status: 'inProgress',
              senderThreadId: thread.id,
              receiverThreadIds: [childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: {},
            }
            this.store.appendItem(turn.id, waitBegin)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: waitBegin,
                startedAtMs: nowMillis(),
              },
            })

            itemIds.set(event.toolUseId, waitId)
            subagentContexts.set(event.toolUseId, subagentContext)
            activeSubagents.add(event.toolUseId)
            armWatchdog()
            return
          }
          if (event.type === 'tool_result' && activeSubagents.has(event.toolUseId)) {
            const ctx = subagentContexts.get(event.toolUseId)
            if (!ctx) return
            const rawResultText = toolResultText(event.content)
            const collabStatus: 'completed' | 'failed' = event.isError ? 'failed' : 'completed'
            const agentStatus: 'completed' | 'errored' = event.isError ? 'errored' : 'completed'

            // claude-agent-sdk's Task tool appends a metadata trailer to the
            // result content: an `agentId: <hex>` line + a `<usage>...</usage>`
            // block. Codex App doesn't render those — they just leak as raw
            // text. Strip them from the visible body and route the metadata
            // into the proper protocol fields (agentNickname / tokenUsage /
            // metrics) so the subagent timeline carries the same identity +
            // usage the SDK reports.
            const parsed = parseSubagentTrailer(rawResultText)
            const resultText = parsed.cleanText

            const childTurn = this.completeSubagentChildTurn(
              peer,
              ctx,
              resultText,
              event.isError ? 'failed' : 'completed',
              event.isError ? { message: 'subagent failed' } : null,
              parsed.usage?.durationMs ?? null,
            )
            recordRunEvent('subagent.completed', {
              parentThreadId: thread.id,
              parentTurnId: turn.id,
              childThreadId: ctx.childThreadId,
              childTurnId: childTurn.id,
              status: childTurn.status,
              agentRole: ctx.subType ?? 'general-purpose',
            })
            const childThread = this.store.getThread(ctx.childThreadId)
            if (childThread) {
              childThread.updatedAt = nowSeconds()
              // Replace our synthetic `agent-{hex}` nickname with the SDK-
              // assigned id so SendMessage / SubAgent navigation in the App
              // uses the same handle the SDK reports.
              if (parsed.agentId) childThread.agentNickname = parsed.agentId
              this.store.upsertThread(childThread)
            }

            // The child completion activity arrives before wait/completed in
            // native V2. The installed Codex cc schema predates the
            // `completed` activity kind, so only send it when the client
            // explicitly advertises support; the wait terminal snapshot is
            // sufficient for legacy reducers.
            if (event.isError || this.supportsCompletedSubagentActivity(peer)) {
              this.emitSubagentActivity(
                peer,
                thread.id,
                turn.id,
                ctx,
                event.isError ? 'interrupted' : 'completed',
              )
            }

            // Push the subagent's token usage as a Codex-native
            // thread/tokenUsage/updated notification on the CHILD thread
            // (App's status bar reads from this) and roll the totals into
            // the parent thread so subagent costs aren't invisible.
            if (parsed.usage && parsed.usage.totalTokens) {
              const breakdown: TokenUsageBreakdown = {
                totalTokens: parsed.usage.totalTokens,
                inputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: parsed.usage.totalTokens,
                reasoningOutputTokens: 0,
              }
              const childUsage: ThreadTokenUsage = {
                total: breakdown,
                last: breakdown,
                modelContextWindow: null,
              }
              this.notify(peer, {
                method: 'thread/tokenUsage/updated',
                params: {
                  threadId: ctx.childThreadId,
                  turnId: childTurn.id,
                  tokenUsage: childUsage,
                },
              })
              this.recordTokenUsage(peer, thread.id, turn.id, {
                input_tokens: 0,
                output_tokens: parsed.usage.totalTokens,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              })
            }

            // Stage 2 close — wait (end). Re-emits the same waitItemId.
            const waitEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: ctx.waitItemId,
              tool: 'wait',
              status: collabStatus,
              senderThreadId: thread.id,
              receiverThreadIds: [ctx.childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: { [ctx.childThreadId]: { status: agentStatus, message: null } },
            }
            this.store.updateItemAndMoveToEnd(turn.id, ctx.waitItemId, () => waitEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: waitEnd,
                completedAtMs: nowMillis(),
              },
            })

            // Codex cc 26.x does not advertise the terminal
            // subAgentActivity kind. For a successful child, wait/completed
            // is already the terminal display state; appending closeAgent
            // makes the bundled client hide the finished child. Keep the
            // legacy closeAgent cleanup only for failed results.
            if (!this.supportsCompletedSubagentActivity(peer) && event.isError) {
              const closeId = newId()
              const closeBegin: ThreadItem = {
                type: 'collabAgentToolCall',
                id: closeId,
                tool: 'closeAgent',
                status: 'inProgress',
                senderThreadId: thread.id,
                receiverThreadIds: [ctx.childThreadId],
                prompt: null,
                model: null,
                reasoningEffort: null,
                agentsStates: {},
              }
              this.store.appendItem(turn.id, closeBegin)
              this.notify(peer, {
                method: 'item/started',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  item: closeBegin,
                  startedAtMs: nowMillis(),
                },
              })
              const closeEnd: ThreadItem = {
                ...closeBegin,
                status: collabStatus,
                agentsStates: { [ctx.childThreadId]: { status: agentStatus, message: null } },
              }
              this.store.updateItem(turn.id, closeId, () => closeEnd)
              this.notify(peer, {
                method: 'item/completed',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  item: closeEnd,
                  completedAtMs: nowMillis(),
                },
              })
            }
            // Keep the context discoverable until the child turn and wait
            // item have both been persisted. If one of those operations throws,
            // the outer settlement path can still finalize the child as failed.
            activeSubagents.delete(event.toolUseId)
            subagentContexts.delete(event.toolUseId)
            if (activeSubagents.size === 0 && !workflowInFlight) disarmWatchdog()
            return
          }
          if (event.type === 'plan_text') {
            if (planItemId) {
              const item = this.store.getTurn(turn.id)?.items.find((i) => i.id === planItemId)
              if (item)
                this.notify(peer, {
                  method: 'item/completed',
                  params: {
                    threadId: thread.id,
                    turnId: turn.id,
                    item,
                    completedAtMs: nowMillis(),
                  },
                })
              planItemId = null
            }
            const itemId = ensurePlanItem()
            this.store.updateItem(turn.id, itemId, (item) =>
              item.type === 'plan' ? { ...item, text: event.text } : item,
            )
            this.notify(peer, {
              method: 'item/plan/delta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.text },
            })
            return
          }
          if (event.type === 'plan_mode') {
            completeMessage()
            if (planItemId) {
              const item = this.store.getTurn(turn.id)?.items.find((i) => i.id === planItemId)
              if (item)
                this.notify(peer, {
                  method: 'item/completed',
                  params: {
                    threadId: thread.id,
                    turnId: turn.id,
                    item,
                    completedAtMs: nowMillis(),
                  },
                })
              planItemId = null
            }
            planMode = event.enabled
            this.threadSettingsUpdate(peer, {
              threadId: thread.id,
              collaborationMode: { mode: planMode ? 'plan' : 'default' },
            })
            return
          }
          if (event.type === 'text_delta') {
            if (event.delta.length === 0) return
            completeReasoningItem()
            hasTextOutput = true
            // In plan mode, text is the plan body — route to a Plan item +
            // item/plan/delta + (later) turn/plan/updated so the App's
            // Plan-mode UI lights up natively. Outside plan mode it's a
            // normal agentMessage delta.
            if (planMode) {
              const itemId = ensurePlanItem()
              this.store.updateItem(turn.id, itemId, (item) => {
                if (item.type === 'plan') return { ...item, text: item.text + event.delta }
                return item
              })
              this.notify(peer, {
                method: 'item/plan/delta',
                params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta },
              })
              return
            }
            const itemId = ensureAgentItem()
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'agentMessage') return { ...item, text: item.text + event.delta }
              return item
            })
            this.notify(peer, {
              method: 'item/agentMessage/delta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta },
            })
            return
          }
          if (event.type === 'reasoning_delta') {
            if (event.delta.length === 0) return
            completeAgentItem('commentary')
            const itemId = ensureReasoningItem()
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'reasoning') {
                return {
                  ...item,
                  content: [(item.content[0] ?? '') + event.delta],
                }
              }
              return item
            })
            this.notify(peer, {
              method: 'item/reasoning/textDelta',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                itemId,
                delta: event.delta,
                contentIndex: 0,
              },
            })
            return
          }
          if (event.type === 'tool_use') {
            // 动态工具由原始回调生成完整生命周期，SDK 的代理 MCP 事件不能再生成重复项。
            if (event.toolName.startsWith('mcp__tyrs_hand__')) return
            if (isWorkflowToolName(event.toolName)) {
              workflowLaunchToolUseIds.add(event.toolUseId)
              workflowInFlight = true
              armWatchdog()
            }
            // Defense in depth against duplicate tool_use events for the same
            // tool_use_id. Claude SDK has been known to emit a block_start
            // event with an empty input AND a complete copy in the final
            // AssistantMessage — sidecar suppresses the empty start, but if
            // anything slips through we'd otherwise create a husk
            // commandExecution item that never closes (the second emit
            // overwrites itemIds[] so the husk never sees its tool_result).
            if (itemIds.has(event.toolUseId)) return
            // Claude's TodoWrite is the equivalent of Codex's `update_plan`
            // todo/checklist tool, which the real app-server maps to a
            // turn/plan/updated notification (structured steps) rather than a
            // timeline item. Mirror that: emit the structured plan and suppress
            // the generic tool item so the App's plan/checklist UI drives off
            // the spec'd notification.
            if (event.toolName === 'TodoWrite') {
              const plan = todoWriteToPlanSteps(event.input)
              if (plan) {
                this.notify(peer, {
                  method: 'turn/plan/updated',
                  params: { threadId: thread.id, turnId: turn.id, explanation: null, plan },
                })
              }
              itemIds.set(event.toolUseId, '')
              return
            }
            const item = this.toolUseToItem(event, thread.cwd)
            itemIds.set(event.toolUseId, item.id)
            itemStartedAtMs.set(item.id, nowMillis())
            this.store.appendItem(turn.id, item)
            this.notify(peer, {
              method: 'item/started',
              params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
            })
            if (item.type === 'fileChange') {
              this.notify(peer, {
                method: 'item/fileChange/patchUpdated',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  itemId: item.id,
                  changes: item.changes,
                },
              })
            }
            return
          }
          if (event.type === 'tool_output_delta') {
            const itemId = itemIds.get(event.toolUseId)
            if (!itemId) return
            commandOutputSeen.add(itemId)
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'commandExecution') {
                return { ...item, aggregatedOutput: `${item.aggregatedOutput ?? ''}${event.delta}` }
              }
              return item
            })
            this.notify(peer, {
              method: 'item/commandExecution/outputDelta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta },
            })
            return
          }
          if (event.type === 'tool_result') {
            if (workflowLaunchToolUseIds.delete(event.toolUseId)) {
              workflowInFlight = workflowLaunchToolUseIds.size > 0
              if (activeSubagents.size === 0 && !workflowInFlight) disarmWatchdog()
            }
            const itemId = itemIds.get(event.toolUseId)
            if (!itemId) return
            const resultText = toolResultText(event.content)
            const durationMs = (() => {
              const started = itemStartedAtMs.get(itemId)
              return started == null ? null : Math.max(0, nowMillis() - started)
            })()
            const parsedExitCode = parseExitCodeFromResult(event.content) ?? (event.isError ? 1 : 0)
            const updated = this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'commandExecution') {
                return {
                  ...item,
                  status: event.isError ? 'failed' : 'completed',
                  aggregatedOutput: item.aggregatedOutput ?? resultText,
                  exitCode: parsedExitCode,
                  durationMs,
                }
              }
              if (item.type === 'fileChange')
                return { ...item, status: event.isError ? 'failed' : 'completed' }
              if (item.type === 'mcpToolCall') {
                // Protocol-correct shape: McpToolCallResult = {content[], structuredContent, _meta};
                // McpToolCallError = {message}. We previously shipped raw event.content for both
                // which crashed App's ts-rs deserializer for any tool that returned anything richer
                // than a primitive. Always wrap into the strict shape.
                return {
                  ...item,
                  status: event.isError ? 'failed' : 'completed',
                  result: event.isError ? null : wrapMcpToolResult(event.content),
                  error: event.isError ? wrapMcpToolError(event.content) : null,
                  durationMs,
                }
              }
              if (item.type === 'webSearch') {
                return { ...item, action: parseWebSearchAction(item.query, resultText) }
              }
              return item
            })
            const item = updated?.items.find((candidate) => candidate.id === itemId)
            if (item?.type === 'commandExecution' && resultText && !commandOutputSeen.has(itemId)) {
              this.notify(peer, {
                method: 'item/commandExecution/outputDelta',
                params: { threadId: thread.id, turnId: turn.id, itemId, delta: resultText },
              })
            }
            if (item && item.type !== 'dynamicToolCall')
              this.notify(peer, {
                method: 'item/completed',
                params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
              })
            const diff = await gitDiff(thread.cwd)
            if (this.store.getTurn(turn.id)?.status !== 'inProgress') return
            if (diff) {
              this.store.updateTurnDiff(turn.id, diff)
              this.notify(peer, {
                method: 'turn/diff/updated',
                params: { threadId: thread.id, turnId: turn.id, diff },
              })
            }
            return
          }
          if (event.type === 'notice') {
            debugLog('turn.runtime.notice', { threadId: thread.id, turnId: turn.id, ...event })
            // Runtime status is not assistant prose. Keep genuine warnings
            // visible in the native warning surface without breaking Markdown.
            if (event.level !== 'info' && !noticesSeen.has(event.message)) {
              noticesSeen.add(event.message)
              this.notify(peer, {
                method: 'warning',
                params: { threadId: thread.id, message: event.message },
              })
            }
            return
          }
          if (event.type === 'usage') {
            this.recordTokenUsage(peer, thread.id, turn.id, event.usage)
            return
          }
          if (event.type === 'hook') {
            // Render hook activity once as a structured Codex hookPrompt item.
            // All fragments of the same hook run share one hookRunId so App
            // groups them under a single execution; the format matches
            // Codex's own hookprompt items (one synthetic run id per emit).
            const hookRunId = newId()
            const fragments: Array<{ text: string; hookRunId: string }> = [
              { text: `Hook · ${event.hookName}`, hookRunId },
            ]
            if (event.status) fragments.push({ text: `status: ${event.status}`, hookRunId })
            if (event.decision) fragments.push({ text: `decision: ${event.decision}`, hookRunId })
            if (event.message) fragments.push({ text: event.message, hookRunId })
            const hookItem: ThreadItem = { type: 'hookPrompt', id: newId(), fragments }
            this.store.appendItem(turn.id, hookItem)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: hookItem,
                startedAtMs: nowMillis(),
              },
            })
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: hookItem,
                completedAtMs: nowMillis(),
              },
            })
            return
          }
          if (event.type === 'metrics') {
            // Track metrics on the runRuntimeTurn closure rather than in the
            // SQLite turns row (which doesn't have these columns). They get
            // merged into the final TurnRecord shipped via turn/completed.
            collectedMetrics.apiDurationMs = event.apiDurationMs
            collectedMetrics.numTurns = event.numTurns
            collectedMetrics.costUsd = event.costUsd
            collectedMetrics.set = true
            return
          }
          if (event.type === 'completed') {
            if (event.claudeSessionId) {
              // Codex-backed threads route the SAME claudeSessionId slot into
              // codex_session_id (used as `codex exec resume <id>` on the
              // next turn). Claude threads keep the original wiring.
              if (isCodexThread) {
                this.store.updateCodexSessionId(thread.id, event.claudeSessionId)
              } else {
                this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
              }
            }
            if (!event.success) throw new Error(event.result ?? 'Claude turn failed')
          }
          if (event.type === 'error') {
            throw new Error(event.message)
          }
        },
        onElicitationRequest: async (request, signal) => {
          if (
            typeof approvalPolicy === 'object' &&
            approvalPolicy !== null &&
            !allowsApproval(approvalPolicy, 'mcp_elicitations')
          )
            return { action: 'decline' }
          if (!turnIsActive() || signal.aborted) return { action: 'cancel' }
          completeMessage()
          const requestId = newId()
          const params = elicitationParams(request, thread.id, turn.id)
          this.setThreadStatus(peer, thread.id, {
            type: 'active',
            activeFlags: ['waitingOnUserInput'],
          })
          try {
            const response = await this.sendServerRequest(
              peer,
              'mcpServer/elicitation/request',
              requestId,
              params,
              signal,
            )
            if (!turnIsActive() || signal.aborted) return { action: 'cancel' }
            return elicitationResponse(request, response)
          } finally {
            if (turnIsActive())
              this.setThreadStatus(peer, thread.id, { type: 'active', activeFlags: [] })
          }
        },
        onPermissionRequest: async (event) => {
          if (!turnIsActive()) return { decision: 'cancel' }
          completeMessage()
          let itemId = itemIds.get(event.toolUseId)
          if (!itemId) {
            const item = this.toolUseToItem(
              {
                type: 'tool_use',
                toolUseId: event.toolUseId,
                toolName: event.toolName,
                input: event.input,
              },
              thread.cwd,
            )
            itemId = item.id
            itemIds.set(event.toolUseId, item.id)
            this.store.appendItem(turn.id, item)
            this.notify(peer, {
              method: 'item/started',
              params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
            })
            if (item.type === 'fileChange') {
              this.notify(peer, {
                method: 'item/fileChange/patchUpdated',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  itemId: item.id,
                  changes: item.changes,
                },
              })
            }
          }
          const decision = await this.requestApproval(peer, thread.id, turn.id, itemId, event)
          if (!turnIsActive()) return { decision: 'cancel' }
          if (decision.decision === 'acceptForSession') {
            const command = String(event.input.command ?? '')
            if (command) {
              const set = this.commandSessionAllow.get(thread.id) ?? new Set<string>()
              set.add(
                JSON.stringify([thread.cwd, thread.approvalPolicy, thread.sandboxMode, command]),
              )
              this.commandSessionAllow.set(thread.id, set)
            }
          }
          return decision
        },
        onUserInputRequest: async (event) => {
          if (!turnIsActive()) return { answers: {} }
          completeMessage()
          // Render AskUserQuestion as Codex's native dynamicToolCall item +
          // item/tool/requestUserInput reverse RPC. The App pops its
          // structured choice card; we wait for the answers, finalise the
          // item, then return the structured answer back to the runtime
          // 答案通过 SDK canUseTool 的 updatedInput 正式返回。
          const item: ThreadItem = {
            type: 'dynamicToolCall',
            id: newId(),
            namespace: 'claude',
            tool: event.toolName ?? 'AskUserQuestion',
            arguments: { questions: event.questions },
            status: 'inProgress',
            contentItems: null,
            success: null,
            durationMs: null,
          }
          this.store.appendItem(turn.id, item)
          const startedAt = nowMillis()
          this.notify(peer, {
            method: 'item/started',
            params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: startedAt },
          })
          this.setThreadStatus(peer, thread.id, {
            type: 'active',
            activeFlags: ['waitingOnUserInput'],
          })
          const answers = await this.requestUserInput(
            peer,
            thread.id,
            turn.id,
            item.id,
            event.questions,
          )
          if (!turnIsActive()) return { answers: {} }
          const contentItems = userInputAnswersAsContent(event.questions, answers)
          const completedItem: ThreadItem = {
            ...item,
            status: 'completed',
            success: true,
            contentItems,
            durationMs: Math.max(0, nowMillis() - startedAt),
          }
          this.store.updateItem(turn.id, item.id, () => completedItem)
          this.notify(peer, {
            method: 'item/completed',
            params: {
              threadId: thread.id,
              turnId: turn.id,
              item: completedItem,
              completedAtMs: nowMillis(),
            },
          })
          this.setThreadStatus(peer, thread.id, { type: 'active', activeFlags: [] })
          return answers
        },
      },
    )
    const runtimeOutcome = runtimeTurn.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({
        kind: 'rejected' as const,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    )
    const outcome = watchdogPromise
      ? await Promise.race([
          runtimeOutcome,
          watchdogPromise.then(() => ({ kind: 'timeout' as const })),
        ])
      : await runtimeOutcome
    disarmWatchdog()
    acceptRuntimeEvents = false
    if (this.stopped) return
    if (outcome.kind === 'timeout') {
      const timeoutSeconds = Math.ceil(watchdogTimeoutMs / 1000)
      const timeoutUnit = timeoutSeconds === 1 ? 'second' : 'seconds'
      const message = `Subagent did not publish a terminal result within ${timeoutSeconds} ${timeoutUnit}.`
      if (this.store.getTurn(turn.id)?.status === 'inProgress') {
        completeMessage()
        this.finalizeOrphanedSubagents(
          peer,
          thread,
          turn,
          subagentContexts,
          activeSubagents,
          message,
        )
        this.subagentStateByTurn.delete(turn.id)
        // 原生中断包含有界强制终止；必须等 CLI 停止后才能释放用户审批。
        await this.runtime.interrupt(thread.id)
      }
      throw new Error(message)
    }
    if (outcome.kind === 'rejected') {
      if (this.store.getTurn(turn.id)?.status === 'inProgress') {
        completeMessage()
        this.finalizeOrphanedSubagents(peer, thread, turn, subagentContexts, activeSubagents)
      }
      this.subagentStateByTurn.delete(turn.id)
      throw outcome.error
    }
    if (this.store.getTurn(turn.id)?.status === 'inProgress') {
      this.finalizeOrphanedSubagents(peer, thread, turn, subagentContexts, activeSubagents)
    }
    this.subagentStateByTurn.delete(turn.id)
    const currentTurn = this.store.getTurn(turn.id)
    if (currentTurn && currentTurn.status !== 'inProgress') return

    const finalDiff = await gitDiff(thread.cwd)
    if (this.stopped) return
    if (this.store.getTurn(turn.id)?.status !== 'inProgress') return
    if (finalDiff) {
      this.store.updateTurnDiff(turn.id, finalDiff)
      this.notify(peer, {
        method: 'turn/diff/updated',
        params: { threadId: thread.id, turnId: turn.id, diff: finalDiff },
      })
    }
    if (params.outputSchema != null && !hasTextOutput) {
      const text = fallbackStructuredText(params.outputSchema, prompt)
      const itemId = ensureAgentItem()
      this.store.updateItem(turn.id, itemId, (item) => {
        if (item.type === 'agentMessage') return { ...item, text }
        return item
      })
      this.notify(peer, {
        method: 'item/agentMessage/delta',
        params: { threadId: thread.id, turnId: turn.id, itemId, delta: text },
      })
    }
    completeMessage('final_answer')
    const planItem = this.store.getTurn(turn.id)?.items.find((item) => item.id === planItemId)
    if (planItem)
      this.notify(peer, {
        method: 'item/completed',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: planItem,
          completedAtMs: nowMillis(),
        },
      })
    const completed: TurnRecord = this.store.completeTurn(turn.id, 'completed') ?? turn
    recordRunEvent('turn.completed', {
      threadId: thread.id,
      turnId: turn.id,
      runtimeBackend: thread.runtimeBackend,
      durationMs: completed.durationMs,
      apiDurationMs: collectedMetrics.apiDurationMs,
      numTurns: collectedMetrics.numTurns,
      costUsd: collectedMetrics.costUsd,
    })
    if (collectedMetrics.set) {
      completed.apiDurationMs = collectedMetrics.apiDurationMs
      completed.numTurns = collectedMetrics.numTurns
      completed.costUsd = collectedMetrics.costUsd
    }
    this.clearActiveTurn(thread.id)
    this.setThreadStatus(peer, thread.id, { type: 'idle' })
    // Plan-mode text streams through the `plan` ThreadItem + item/plan/delta
    // events; turn/plan/updated is reserved for the update_plan/TodoWrite
    // checklist tool (see the tool_use handler), matching the real app-server
    // which keeps those two surfaces separate.
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId: thread.id, turn: this.toLifecycleTurn(completed) },
    })
  }

  private completeSubagentChildTurn(
    peer: RpcPeer,
    context: SubagentContext,
    resultText: string,
    status: 'completed' | 'failed',
    error: unknown | null,
    durationMs: number | null = null,
  ): TurnRecord {
    let childTurn = this.store.getTurn(context.childTurnId)
    if (!childTurn) {
      childTurn = {
        id: context.childTurnId,
        threadId: context.childThreadId,
        status: 'inProgress',
        startedAt: nowSeconds(),
        completedAt: null,
        durationMs: null,
        items: [
          {
            type: 'userMessage',
            id: newId(),
            content: [{ type: 'text', text: context.prompt, text_elements: [] }],
          },
        ],
        diff: '',
        error: null,
      }
      this.store.upsertTurn(childTurn)
    }

    const agentItemId = newId()
    const startedItem: ThreadItem = {
      type: 'agentMessage',
      id: agentItemId,
      text: '',
      phase: null,
      memoryCitation: null,
    }
    this.store.appendItem(childTurn.id, startedItem)
    this.notify(peer, {
      method: 'item/started',
      params: {
        threadId: context.childThreadId,
        turnId: childTurn.id,
        item: startedItem,
        startedAtMs: nowMillis(),
      },
    })

    const completedItem: ThreadItem = { ...startedItem, text: resultText }
    this.store.updateItem(childTurn.id, agentItemId, () => completedItem)
    if (resultText) {
      this.notify(peer, {
        method: 'item/agentMessage/delta',
        params: {
          threadId: context.childThreadId,
          turnId: childTurn.id,
          itemId: agentItemId,
          delta: resultText,
        },
      })
    }
    this.notify(peer, {
      method: 'item/completed',
      params: {
        threadId: context.childThreadId,
        turnId: childTurn.id,
        item: completedItem,
        completedAtMs: nowMillis(),
      },
    })

    const completed = this.store.completeTurn(childTurn.id, status, error) ?? childTurn
    if (durationMs != null) {
      completed.durationMs = durationMs
      this.store.upsertTurn(completed)
    }
    this.setThreadStatus(peer, context.childThreadId, { type: 'idle' })
    this.notify(peer, {
      method: 'turn/completed',
      params: {
        threadId: context.childThreadId,
        turn: this.toCompletedTurn(completed),
      },
    })
    return completed
  }

  private emitSubagentActivity(
    peer: RpcPeer,
    parentThreadId: string,
    parentTurnId: string,
    context: SubagentContext,
    kind: 'started' | 'interacted' | 'interrupted' | 'completed',
  ): void {
    // Codex cc 26.x treats a persisted started activity marker as liveness,
    // but does not advertise a compatible terminal activity kind. The
    // canonical spawnAgent/wait lifecycle remains available for discovery and
    // review, so omit this optional marker for legacy peers.
    if (!this.supportsCompletedSubagentActivity(peer) && kind !== 'interrupted') return
    const item: ThreadItem = {
      type: 'subAgentActivity',
      id: newId(),
      kind,
      agentThreadId: context.childThreadId,
      agentPath: context.agentPath,
    }
    // Keep the persisted history capability-neutral. The durable wait and
    // child-turn state covers live and completed runs; persisting either
    // started or completed activity would make a mixed-version reconnect
    // decode a kind the peer may not support. Interrupted remains the one
    // legacy-safe terminal marker for abandoned children.
    if (kind === 'interrupted') this.store.appendItem(parentTurnId, item)
    this.emitItemLifecycle(peer, parentThreadId, parentTurnId, item)
  }

  private emitItemLifecycle(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    item: ThreadItem,
  ): void {
    const startedAtMs = nowMillis()
    this.notify(peer, {
      method: 'item/started',
      params: {
        threadId,
        turnId,
        item,
        startedAtMs,
      },
    })
    this.notify(peer, {
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item,
        completedAtMs: nowMillis(),
      },
    })
  }

  private supportsCompletedSubagentActivity(peer: RpcPeer): boolean {
    if (process.env.CLAUDE_CODEX_SUBAGENT_COMPLETED === '1') return true
    if (process.env.CLAUDE_CODEX_SUBAGENT_COMPLETED === '0') return false
    return this.peerFeatures.get(peer)?.supportsCompletedSubagentActivity === true
  }

  private finalizeOrphanedSubagents(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    contexts: Map<string, SubagentContext>,
    active: Set<string>,
    failureMessage = 'Subagent ended without a terminal task result.',
  ): void {
    for (const toolUseId of Array.from(active)) {
      const context = contexts.get(toolUseId)
      active.delete(toolUseId)
      contexts.delete(toolUseId)
      if (!context) continue

      const message = failureMessage
      const childTurn = this.completeSubagentChildTurn(peer, context, message, 'failed', {
        message,
      })
      recordRunEvent('subagent.completed', {
        parentThreadId: thread.id,
        parentTurnId: turn.id,
        childThreadId: context.childThreadId,
        childTurnId: childTurn.id,
        status: 'failed',
        agentRole: context.subType ?? 'general-purpose',
      })

      this.emitSubagentActivity(peer, thread.id, turn.id, context, 'interrupted')

      const waitEnd: ThreadItem = {
        type: 'collabAgentToolCall',
        id: context.waitItemId,
        tool: 'wait',
        status: 'failed',
        senderThreadId: thread.id,
        receiverThreadIds: [context.childThreadId],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: { [context.childThreadId]: { status: 'errored', message } },
      }
      this.store.updateItemAndMoveToEnd(turn.id, context.waitItemId, () => waitEnd)
      this.notify(peer, {
        method: 'item/completed',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: waitEnd,
          completedAtMs: nowMillis(),
        },
      })
      if (!this.supportsCompletedSubagentActivity(peer)) {
        const closeId = newId()
        const closeBegin: ThreadItem = {
          type: 'collabAgentToolCall',
          id: closeId,
          tool: 'closeAgent',
          status: 'inProgress',
          senderThreadId: thread.id,
          receiverThreadIds: [context.childThreadId],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        }
        this.store.appendItem(turn.id, closeBegin)
        this.notify(peer, {
          method: 'item/started',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: closeBegin,
            startedAtMs: nowMillis(),
          },
        })
        const closeEnd: ThreadItem = {
          ...closeBegin,
          status: 'failed',
          agentsStates: { [context.childThreadId]: { status: 'errored', message } },
        }
        this.store.updateItem(turn.id, closeId, () => closeEnd)
        this.notify(peer, {
          method: 'item/completed',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: closeEnd,
            completedAtMs: nowMillis(),
          },
        })
      }
    }
  }

  private async requestApproval(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    itemId: string,
    event: Extract<RuntimeEvent, { type: 'permission_request' }>,
  ): Promise<PermissionDecision> {
    // runtime 已按当前 Turn 权限判断；抵达此处的请求必须由用户决定。
    const thread = this.store.getThread(threadId)
    const command = String(event.input.command ?? '')
    const grantKey = JSON.stringify([
      thread?.cwd,
      thread?.approvalPolicy,
      thread?.sandboxMode,
      command,
    ])
    if (command && this.commandSessionAllow.get(threadId)?.has(grantKey)) {
      return { decision: 'accept' }
    }

    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: ['waitingOnApproval'] })
    const requestId = newId()
    const isCommand = event.toolName === 'Bash'
    const method = isCommand
      ? 'item/commandExecution/requestApproval'
      : 'item/fileChange/requestApproval'
    const params = isCommand
      ? {
          threadId,
          turnId,
          itemId,
          startedAtMs: nowMillis(),
          approvalId: requestId,
          reason: null,
          command,
          cwd: String(event.input.cwd ?? ''),
          commandActions: [],
          additionalPermissions: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
          availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        }
      : {
          threadId,
          turnId,
          itemId,
          startedAtMs: nowMillis(),
          reason: null,
          grantRoot: null,
        }

    let response: unknown
    try {
      response = await this.sendServerRequest(peer, method, requestId, params)
    } finally {
      if (!this.stopped && this.activeTurnByThread.get(threadId) === turnId)
        this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    }
    const decision = normalizeDecision(response)
    return { decision }
  }

  private async requestUserInput(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    itemId: string,
    questions: UserInputQuestion[],
  ): Promise<UserInputAnswers> {
    const requestId = newId()
    // Always guarantee an "Other" affordance so the App's free-text fallback
    // is available, even when the upstream caller (Claude tool input, mock
    // runtime, etc.) didn't model it explicitly.
    const normalized = questions.map((q) => {
      const options = q.options ?? []
      const hasOther = options.some((o) => o.label === 'Other')
      return hasOther
        ? q
        : {
            ...q,
            options: [...options, { label: 'Other', description: 'Provide a free-form answer' }],
          }
    })
    const params = { threadId, turnId, itemId, isBlocking: true, questions: normalized }
    const response = await this.sendServerRequest(
      peer,
      'item/tool/requestUserInput',
      requestId,
      params,
    )
    return normalizeUserInputAnswers(response, normalized)
  }

  private async turnInterrupt(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    const requestedTurnId = requiredString(params.turnId, 'turnId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '会话不存在')
    const requested = this.store.getTurn(requestedTurnId)
    if (requested && requested.threadId !== threadId)
      throw new ProtocolError(-32602, '回合不属于指定会话')
    const activeTurnId = this.activeTurnByThread.get(threadId)
    if (activeTurnId && activeTurnId !== requestedTurnId)
      throw new ProtocolError(-32009, '指定回合与当前活动回合不一致')
    if (!requested) throw new ProtocolError(-32602, '指定回合不存在')
    const stopping = this.interruptingByThread.get(threadId)
    if (stopping) {
      await stopping
      return {}
    }
    if (requested.status !== 'inProgress') return {}
    this.activePeerByThread.set(threadId, peer)
    const turnId = activeTurnId || requestedTurnId
    if (turnId) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        const subagents = this.subagentStateByTurn.get(turnId)
        if (subagents) {
          this.finalizeOrphanedSubagents(
            peer,
            subagents.thread,
            subagents.turn,
            subagents.contexts,
            subagents.active,
          )
          this.subagentStateByTurn.delete(turnId)
        }
        this.store.completeTurn(turnId, 'interrupted', { message: 'interrupted' })
      }
    }
    this.runtimeReadyByTurn.get(turnId)?.resolve(false)
    // Persist the terminal state before asking the SDK to abort. A few SDK
    // versions deliver one or two buffered tool events during interrupt; the
    // runRuntimeTurn guard now rejects them because the turn is no longer
    // active, so they cannot create an orphan child after this point.
    // 终态先落库，执行权仍保留到 SDK 真正停止，防止旧 interrupt 命中新回合。
    // 停止失败时保留屏障，明确拒绝新提交；重启运行时后才能恢复。
    // CLI 确认中断之后才能释放交互，不能只依赖 SDK 的 stdin EOF。
    const interrupting = (async () => this.runtime.interrupt(threadId))()
    this.interruptingByThread.set(threadId, interrupting)
    await interrupting
    this.pendingInteractions.cancelThread(threadId)
    const completed = this.store.getTurn(turnId)
    if (completed)
      this.notify(peer, {
        method: 'turn/completed',
        params: { threadId, turn: this.toLifecycleTurn(completed) },
      })
    this.interruptingByThread.delete(threadId)
    this.clearActiveTurn(threadId)
    this.setThreadStatus(peer, threadId, { type: 'idle' })
    return {}
  }

  private async turnSteer(_peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(params.threadId, 'threadId')
    const expectedTurnId = requiredString(params.expectedTurnId, 'expectedTurnId')
    if (!this.store.getThread(threadId)) throw new ProtocolError(-32602, '会话不存在')
    const messageId =
      params.clientUserMessageId == null
        ? null
        : requiredString(params.clientUserMessageId, 'clientUserMessageId')
    const hash = submissionHash({ method: 'turn/steer', ...params })
    if (messageId) {
      const submitted = this.store.submittedTurn(threadId, messageId, hash)
      if (submitted) return { turnId: submitted.id }
    }
    const activeTurnId = this.activeTurnByThread.get(threadId)
    if (
      !activeTurnId ||
      expectedTurnId !== activeTurnId ||
      this.store.getTurn(activeTurnId)?.status !== 'inProgress'
    )
      throw new ProtocolError(-32009, '指定回合与当前活动回合不一致')
    const startup = this.runtimeReadyByTurn.get(activeTurnId)
    if (startup && !(await startup.ready)) throw new ProtocolError(-32009, '回合未启动便已终结')
    // 等待启动时另一端可能提交相同消息或取消回合，落库前再次核对。
    if (messageId) {
      const submitted = this.store.submittedTurn(threadId, messageId, hash)
      if (submitted) return { turnId: submitted.id }
    }
    if (this.activeTurnByThread.get(threadId) !== activeTurnId)
      throw new ProtocolError(-32009, '回合已终结')
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    const prompt = textFromInput(input)
    // The steered message is retained on the turn for history (thread/read), but
    // — like a normal turn's user message — it is NOT surfaced as a userMessage
    // item/started+item/completed event. The real app-server's turn_steer just
    // feeds the input into the core (steer_input) and EventMsg::UserMessage is
    // unhandled in the live stream, so no userMessage item event is emitted.
    const item: ThreadItem = {
      type: 'userMessage',
      id: newId(),
      content: input,
      clientId: messageId,
    }
    this.store.saveSteeredMessage(activeTurnId, item, messageId, hash)
    await this.runtime.steer(threadId, prompt)
    return { turnId: activeTurnId }
  }

  private mcpScope(value?: unknown): McpScope {
    const threadId = value == null ? null : requiredString(value, 'threadId')
    const thread = threadId === null ? null : this.store.getThread(threadId)
    if (threadId !== null && !thread) throw new ProtocolError(-32602, '未知会话')
    const configured =
      threadId === null ? undefined : this.store.threadSettings(threadId).config?.mcp_servers
    const servers = configured ?? this.configOverrides.mcp_servers ?? readMcpConfig()
    sdkMcpServers(servers)
    return {
      threadId,
      cwd: thread?.cwd ?? process.cwd(),
      servers: servers as Record<string, unknown>,
    }
  }

  private mcpCallbacks(peer: RpcPeer, value?: unknown): McpCallbacks {
    const threadId = value == null ? null : requiredString(value, 'threadId')
    return {
      peerId: peer.id,
      status: (name, status, error) => {
        this.notify(peer, {
          method: 'mcpServer/startupStatus/updated',
          params: { threadId, name, status, error },
        })
      },
      elicitation: async (request, signal) => {
        if (!threadId) throw new ProtocolError(-32602, 'MCP 交互需要指定会话')
        const policy = this.store.getThread(threadId)?.approvalPolicy
        if (policy && typeof policy === 'object' && !allowsApproval(policy, 'mcp_elicitations'))
          return { action: 'decline' }
        const requestId = newId()
        const response = await this.sendServerRequest(
          peer,
          'mcpServer/elicitation/request',
          requestId,
          elicitationParams(request, threadId, null),
          signal,
        )
        signal.throwIfAborted()
        return elicitationResponse(request, response)
      },
    }
  }

  private async mcpProbe(peer: RpcPeer, scope: McpScope): Promise<void> {
    for (const name of Object.keys(sdkMcpServers(scope.servers)))
      await this.mcp.withClient(
        scope,
        name,
        this.mcpCallbacks(peer, scope.threadId),
        async (client, signal) => {
          await client.ping({ signal })
        },
      )
  }

  private async mcpReload(peer: RpcPeer): Promise<unknown> {
    if (this.activeTurnByThread.size)
      throw new ProtocolError(-32009, '回合执行期间不能重载 MCP，请先停止回合')
    await this.mcp.cancelAll()
    const scopes = [
      this.mcpScope(),
      ...[...this.activePeerByThread.keys()].map((id) => this.mcpScope(id)),
    ]
    for (const scope of scopes) await this.mcpProbe(peer, scope)
    return {}
  }

  private async mcpCall(
    peer: RpcPeer,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const isTool = method === 'mcpServer/tool/call'
    const scope = this.mcpScope(
      isTool ? requiredString(params.threadId, 'threadId') : params.threadId,
    )
    const server = requiredString(params.server, 'server')
    const target = requiredString(isTool ? params.tool : params.uri, isTool ? 'tool' : 'uri')
    if (isTool) {
      const thread = this.store.getThread(scope.threadId!)!
      if (this.activeTurnByThread.has(thread.id))
        throw new ProtocolError(-32009, '回合执行期间不能从管理接口并发调用工具')
      // 任意 MCP 工具没有可信的副作用边界，管理接口不能绕过原生权限。
      if (
        thread.sandboxMode !== 'danger-full-access' ||
        this.store.threadSettings(thread.id).planMode
      )
        throw new ProtocolError(-32004, '直接 MCP 工具调用需要完整权限会话')
      if (
        params.arguments != null &&
        (typeof params.arguments !== 'object' || Array.isArray(params.arguments))
      )
        throw new ProtocolError(-32602, 'MCP arguments 必须是对象')
      if (params._meta != null && (typeof params._meta !== 'object' || Array.isArray(params._meta)))
        throw new ProtocolError(-32602, 'MCP _meta 必须是对象')
    }
    return this.mcp.withClient(
      scope,
      server,
      this.mcpCallbacks(peer, scope.threadId),
      async (client, signal) => {
        if (!isTool) return client.readResource({ uri: target }, { signal })
        return client.callTool(
          {
            name: target,
            arguments: asRecord(params.arguments),
            ...(params._meta == null ? {} : { _meta: asRecord(params._meta) }),
          },
          undefined,
          { signal },
        )
      },
    )
  }

  private configRead(): unknown {
    // Base config = our typed defaults; overrides (whatever the App's
    // settings sheet has written previously via config/value/write) are
    // layered on top so the user sees their last-saved values instead of
    // the defaults bouncing back on every reconnect. Typed fields (model /
    // model_reasoning_effort) take precedence over overrides since they're
    // applied via a stricter validator.
    return {
      config: {
        ...this.publicConfigOverrides(),
        model: this.configModel,
        review_model: null,
        model_context_window: null,
        model_auto_compact_token_limit: null,
        model_provider: 'claude-code',
        approval_policy: this.configOverrides.approval_policy ?? 'on-request',
        approvals_reviewer: this.configOverrides.approvals_reviewer ?? 'user',
        sandbox_mode: this.configOverrides.sandbox_mode ?? 'workspace-write',
        sandbox_workspace_write: this.configOverrides.sandbox_workspace_write ?? null,
        forced_chatgpt_workspace_id: null,
        forced_login_method: null,
        web_search: this.configOverrides.web_search ?? 'disabled',
        tools: this.configOverrides.tools ?? null,
        profile: this.configOverrides.profile ?? null,
        profiles: {},
        instructions: this.configOverrides.instructions ?? null,
        developer_instructions: this.configOverrides.developer_instructions ?? null,
        compact_prompt: this.configOverrides.compact_prompt ?? null,
        model_reasoning_effort: this.configReasoningEffort,
        model_reasoning_summary: this.configOverrides.model_reasoning_summary ?? null,
        model_verbosity: this.configOverrides.model_verbosity ?? null,
        service_tier: this.configOverrides.service_tier ?? null,
        analytics: this.configOverrides.analytics ?? null,
        apps: this.configOverrides.apps ?? null,
        model_providers: this.exposedModelProviders(),
        provider_loop_config: projectProviderLoopConfig(
          undefined,
          this.providerLoopSelectionInput(),
        ),
      },
      origins: {
        model_provider: configLayerMetadata(),
        'model_providers.claude-code': configLayerMetadata(),
      },
      layers: null,
    }
  }

  private providerLoopSelectionInput(): ProviderLoopSelectionInput {
    const legacyRuntimeType = normalizeRuntimeType(
      process.env.CLAUDE_CODEX_RUNTIME_TYPE ??
        process.env.CLAUDE_CODEX_RUNTIME ??
        process.env.CLAUDE_CODEX_BACKEND,
    )
    const envInput = providerLoopSelectionInputFromEnv(process.env, legacyRuntimeType)
    if (hasProviderLoopSelectionInput(envInput)) return envInput
    return providerLoopSelectionInputFromConfig(
      this.configOverrides,
      legacyRuntimeType,
      process.env.CLAUDE_CODEX_MOCK === '1',
    )
  }

  private publicConfigOverrides(): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.configOverrides).filter(
        ([key]) => !isProviderLoopSelectionConfigKey(key),
      ),
    )
  }

  // Build the model_providers map served by config/read. Always exposes
  // 'claude-code'; conditionally adds 'codex' when a real Codex CLI is
  // resolvable on the host. Exposing 'codex' as a separate provider entry
  // gives the App's settings panel a way to surface OpenAI-family models
  // (gpt-*) without the App treating them as foreign to the Claude
  // provider's allowlist.
  private exposedModelProviders(): Record<string, unknown> {
    const providers: Record<string, unknown> = {
      'claude-code': {
        name: 'Claude Code',
        base_url: null,
        env_key: null,
        env_key_instructions: null,
        experimental_bearer_token: null,
        auth: null,
        aws: null,
        wire_api: 'responses',
        query_params: null,
        http_headers: null,
        env_http_headers: null,
        request_max_retries: null,
        stream_max_retries: null,
        stream_idle_timeout_ms: null,
        websocket_connect_timeout_ms: null,
        requires_openai_auth: false,
        supports_websockets: false,
      },
    }
    return providers
  }

  private modelList(params: Record<string, unknown>): unknown {
    if (params.includeHidden != null && typeof params.includeHidden !== 'boolean')
      throw new ProtocolError(-32602, 'includeHidden 必须是布尔值')
    const defaultModel = this.configModel
    const options = allSelectableModelOptions()
    const hasConfiguredDefault = options.some((option) => option.id === defaultModel)
    const reasoningEfforts = [
      { reasoningEffort: 'low', description: 'Fast runtime response' },
      { reasoningEffort: 'medium', description: 'Balanced runtime response' },
      { reasoningEffort: 'high', description: 'Deeper runtime response' },
      { reasoningEffort: 'xhigh', description: 'Maximum reasoning' },
    ]
    const models = options.map((option) => ({
      id: option.id,
      model: option.id,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: option.displayName,
      description: option.description,
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: reasoningEfforts,
      defaultReasoningEffort: this.configReasoningEffort,
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: hasConfiguredDefault ? option.id === defaultModel : option.isDefault === true,
    }))
    // 目录或查询条件改变后，旧游标不能静默读取不一致的下一页。
    const scope = `models:${submissionHash({ models, includeHidden: params.includeHidden ?? false })}`
    const { data, nextCursor } = pageRecords(
      models,
      { ...params, sortDirection: 'asc' },
      scope,
      (model) => model.id,
    )
    return { data, nextCursor }
  }

  private accountRateLimits(): unknown {
    const rateLimits = {
      limitId: 'claude-code',
      limitName: 'Claude Code',
      primary: null,
      secondary: null,
      credits: null,
      planType: null,
      rateLimitReachedType: null,
    }
    return { rateLimits, rateLimitsByLimitId: { 'claude-code': rateLimits } }
  }

  // Accumulates Claude Agent SDK token usage per thread and pushes a
  // `thread/tokenUsage/updated` notification so the Codex App can render real
  // consumption instead of leaving the meter blank.
  private recordTokenUsage(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    usage: Record<string, unknown>,
  ): void {
    const last = tokenBreakdownFromClaudeUsage(usage)
    if (last.totalTokens === 0) return
    const prior = this.store.threadUsage(threadId)?.tokenUsage.total ?? emptyTokenBreakdown()
    const total: TokenUsageBreakdown = {
      totalTokens: prior.totalTokens + last.totalTokens,
      inputTokens: prior.inputTokens + last.inputTokens,
      cachedInputTokens: prior.cachedInputTokens + last.cachedInputTokens,
      outputTokens: prior.outputTokens + last.outputTokens,
      reasoningOutputTokens: prior.reasoningOutputTokens + last.reasoningOutputTokens,
    }
    const tokenUsage: ThreadTokenUsage = { total, last, modelContextWindow: null }
    this.store.saveThreadUsage(threadId, turnId, tokenUsage)
    this.notify(peer, {
      method: 'thread/tokenUsage/updated',
      params: { threadId, turnId, tokenUsage },
    })
    // NOTE: previously we also pushed `account/rateLimits/updated` here on
    // every token-usage event "to keep the UI in sync". That backfired —
    // Codex App treats every such notification as a fresh rate-limit signal
    // and surfaces it as a transient warning banner, so the user saw a
    // rate-limit pop on every assistant turn. Since we don't actually have
    // real rate-limit data from the Anthropic SDK (no headers exposed), the
    // notification was empty noise. The initial snapshot still fires once
    // post-handshake in `initialize` so the UI populates on first connect.
  }

  private marketplaceAdd(params: Record<string, unknown>): unknown {
    const source = stringOr(params.source, 'local')
    const marketplaceName = stringOr(
      params.refName,
      source.split('/').filter(Boolean).at(-1) ?? 'marketplace',
    )
    return {
      marketplaceName,
      installedRoot: `${codexHome()}/marketplaces/${marketplaceName}`,
      alreadyAdded: true,
    }
  }

  private marketplaceRemove(params: Record<string, unknown>): unknown {
    const marketplaceName = stringOr(params.marketplaceName, 'marketplace')
    return { marketplaceName, installedRoot: null }
  }

  private marketplaceUpgrade(params: Record<string, unknown>): unknown {
    const marketplaceName =
      typeof params.marketplaceName === 'string' ? params.marketplaceName : null
    return {
      selectedMarketplaces: marketplaceName ? [marketplaceName] : [],
      upgradedRoots: [],
      errors: [],
    }
  }

  private pluginShareSave(params: Record<string, unknown>): unknown {
    const remotePluginId = stringOr(params.remotePluginId, `local-${newId()}`)
    return {
      remotePluginId,
      shareUrl: `https://localhost.invalid/claude-codex/plugin-share/${encodeURIComponent(remotePluginId)}`,
    }
  }

  private pluginShareUpdateTargets(params: Record<string, unknown>): unknown {
    const shareTargets = Array.isArray(params.shareTargets) ? params.shareTargets : []
    return {
      principals: shareTargets.map((target) => {
        const rec = asRecord(target)
        return {
          principalType: stringOr(rec.principalType, 'user'),
          principalId: stringOr(rec.principalId, ''),
          name: stringOr(rec.principalId, 'unknown'),
        }
      }),
      discoverability: params.discoverability === 'UNLISTED' ? 'UNLISTED' : 'PRIVATE',
    }
  }

  private configWriteResponse(params: Record<string, unknown>): unknown {
    // 先校验整个批次，避免无效 MCP 配置污染持久化设置。
    for (const edit of configEdits(params))
      if (edit.keyPath === 'mcp_servers' && edit.value != null) sdkMcpServers(edit.value)
    for (const edit of configEdits(params)) {
      const { keyPath, value } = edit
      if (keyPath === 'model' && typeof value === 'string' && value.length > 0) {
        this.configModel = normalizeSelectableModelId(value, this.configModel)
      } else if (keyPath === 'model_reasoning_effort' && typeof value === 'string') {
        this.configReasoningEffort =
          normalizeCodexReasoningEffort(value) ?? this.configReasoningEffort
      } else {
        // Unknown key — store in the generic overrides bag so it survives a
        // restart even though we don't apply it to typed runtime state. This
        // captures approvalPolicy, sandboxMode, instruction toggles, anything
        // the App's settings sheet may emit. `null` value clears the entry.
        if (value === null || value === undefined) {
          delete this.configOverrides[keyPath]
        } else {
          this.configOverrides[keyPath] = value
        }
      }
    }
    this.persistConfig()
    const filePath = stringOr(params.filePath, `${codexHome()}/config.toml`)
    return {
      status: 'ok',
      version: `claude-codex-${nowSeconds()}`,
      filePath,
      overriddenMetadata: null,
    }
  }

  private pluginRead(params: Record<string, unknown>): unknown {
    const name = stringOr(params.pluginName, 'unknown')
    return {
      plugin: {
        marketplaceName: stringOr(params.remoteMarketplaceName, 'local'),
        marketplacePath: params.marketplacePath ?? null,
        summary: {
          id: name,
          name,
          shareContext: null,
          source: { type: 'remote' },
          installed: false,
          enabled: false,
          installPolicy: 'NOT_AVAILABLE',
          authPolicy: 'ON_USE',
          availability: 'AVAILABLE',
          interface: null,
          keywords: [],
        },
        description: null,
        skills: [],
        hooks: [],
        apps: [],
        mcpServers: [],
      },
    }
  }

  private getConversationSummary(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.conversationId, '')
    const thread = this.store.getThread(threadId) ?? this.store.listThreads({ limit: 1 }).at(0)
    const now = new Date().toISOString()
    return {
      summary: {
        conversationId: thread?.id ?? threadId,
        path: '',
        preview: thread?.preview ?? '',
        timestamp: now,
        updatedAt: now,
        modelProvider: thread?.modelProvider ?? 'claude-code',
        cwd: thread?.cwd ?? process.cwd(),
        cliVersion: codexCliVersion(),
        source: normalizeSessionSource(thread?.source),
        gitInfo: null,
      },
    }
  }

  private async gitDiffToRemote(params: Record<string, unknown>): Promise<unknown> {
    const cwd = stringOr(params.cwd, process.cwd())
    const diff = await gitDiff(cwd)
    let sha = ''
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 10_000 })
      sha = stdout.trim()
    } catch {}
    return { sha, diff }
  }

  private async fuzzyFileSearch(params: Record<string, unknown>): Promise<unknown> {
    const query = stringOr(params.query, '')
    const roots = Array.isArray(params.roots) ? params.roots.map(String) : [process.cwd()]
    return { files: await this.fuzzySearchCore(query, roots) }
  }

  private async fuzzySearchCore(
    rawQuery: string,
    roots: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const files: Array<{
      root: string
      path: string
      match_type: string
      file_name: string
      score: number
      indices: number[]
    }> = []
    for (const root of roots) {
      const paths = await listFiles(root)
      for (const path of paths) {
        const fileName = path.split('/').at(-1) ?? path
        const match = fuzzyPathMatch(rawQuery, path)
        if (!match) continue
        files.push({
          root,
          path,
          match_type: 'file',
          file_name: fileName,
          ...match,
        })
      }
    }
    return files
      .sort(
        (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.root.localeCompare(b.root),
      )
      .slice(0, 100)
  }

  private fuzzySessionStart(params: Record<string, unknown>): unknown {
    const sessionId = stringOr(params.sessionId, '')
    const roots = Array.isArray(params.roots) ? params.roots.map(String) : [process.cwd()]
    if (sessionId) this.fuzzySessions.set(sessionId, { roots })
    return {}
  }

  private async fuzzySessionUpdate(
    peer: RpcPeer,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const sessionId = stringOr(params.sessionId, '')
    const query = stringOr(params.query, '')
    const session = this.fuzzySessions.get(sessionId)
    const roots = session?.roots ?? [process.cwd()]
    const files = await this.fuzzySearchCore(query, roots)
    if (session && this.fuzzySessions.get(sessionId) === session) {
      this.notify(peer, {
        method: 'fuzzyFileSearch/sessionUpdated',
        params: { sessionId, query, files },
      })
    }
    return {}
  }

  private fuzzySessionStop(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const sessionId = stringOr(params.sessionId, '')
    this.fuzzySessions.delete(sessionId)
    if (sessionId) {
      this.notify(peer, {
        method: 'fuzzyFileSearch/sessionCompleted',
        params: { sessionId },
      })
    }
    return {}
  }

  private toolUseToItem(
    event: Extract<RuntimeEvent, { type: 'tool_use' }>,
    cwd: string,
  ): ThreadItem {
    const id = newId()
    if (event.toolName === 'Bash') {
      return {
        type: 'commandExecution',
        id,
        command: String(event.input.command ?? ''),
        cwd: String(event.input.cwd ?? cwd),
        // Use the SDK's tool_use_id as a stable handle. Without a non-null
        // processId the Codex App was treating these as "Background terminal"
        // entries (no attached process) and hiding their output; with a
        // synthetic id they render as inline command items like a normal
        // foreground bash invocation.
        processId: `claude:${event.toolUseId}`,
        source: 'agent',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      }
    }
    if (['Edit', 'Write', 'MultiEdit'].includes(event.toolName)) {
      return {
        type: 'fileChange',
        id,
        changes: fileChangeFromTool(event.toolName, event.input),
        status: 'inProgress',
      }
    }
    if (event.toolName === 'WebSearch') {
      // Codex App has a dedicated `webSearch` ThreadItem with a structured
      // action — emit it instead of a generic mcpToolCall so the App can show
      // the search badge (and follow-up open-page links) natively. The action
      // is finalized when the tool_result arrives (see tool_result handler).
      // The 'search' variant's `query` / `queries` are required (Option fields
      // with no serde default), so always populate both even on the initial
      // inProgress emit.
      const q = String(event.input.query ?? '')
      return {
        type: 'webSearch',
        id,
        query: q,
        action: { type: 'search', query: q || null, queries: null },
      }
    }
    let displayTool = event.toolName
    if (event.toolName === 'Read') {
      const raw = String(event.input.file_path || event.input.path || '')
      if (raw) {
        let displayPath = raw
        try {
          if (cwd && raw.startsWith(cwd)) {
            displayPath = raw.slice(cwd.length).replace(/^\/+/, '')
          } else {
            const parts = raw.split(/\//).filter(Boolean)
            displayPath = parts.length > 2 ? parts.slice(-2).join('/') : raw
          }
        } catch {}
        displayTool = `Read ${displayPath || raw}`
      }
    } else if (event.toolName === 'Grep') {
      const pat = String(event.input.pattern ?? '')
      const rawPath = event.input.path ? String(event.input.path) : ''
      let pathStr = ''
      if (rawPath) {
        const parts = rawPath.split(/\//).filter(Boolean)
        pathStr = ` (${parts.length > 2 ? parts.slice(-2).join('/') : rawPath})`
      }
      if (pat) displayTool = `Grep ${pat}${pathStr}`
    } else if (event.toolName === 'Glob') {
      const pat = String(event.input.pattern ?? '')
      if (pat) displayTool = `Glob ${pat}`
    }

    return {
      type: 'mcpToolCall',
      id,
      server: 'claude-code',
      tool: displayTool,
      status: 'inProgress',
      arguments: event.input,
      result: null,
      error: null,
      durationMs: null,
    }
  }

  private threadEnvelope(thread: ThreadRecord, turns: TurnRecord[] = []): unknown {
    const activePermissionProfileId = threadPermissionProfileId(
      thread.permissionProfileId,
      thread.approvalPolicy,
      thread.sandboxMode,
    )
    return {
      thread: this.toThread(thread, turns),
      model: thread.model,
      modelProvider: thread.modelProvider,
      serviceTier: null,
      cwd: thread.cwd,
      runtimeWorkspaceRoots: [thread.cwd],
      instructionSources: [],
      approvalPolicy: thread.approvalPolicy ?? 'never',
      approvalsReviewer: 'user',
      sandbox:
        this.store.threadSettings(thread.id).sandboxPolicy ??
        sandboxEnvelope(thread.sandboxMode, thread.cwd),
      permissionProfile: null,
      activePermissionProfile: activePermissionProfileId
        ? { id: activePermissionProfileId, extends: null }
        : null,
      // Some newer clients read the compact id while older clients use the
      // structured activePermissionProfile field. Return both; unknown extra
      // fields are ignored by the legacy app-server schema.
      permissions: activePermissionProfileId,
      reasoningEffort: thread.reasoningEffort,
      multiAgentMode: 'explicitRequestOnly',
      initialTurnsPage: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    }
  }

  private toThread(thread: ThreadRecord, turns: TurnRecord[] = []): unknown {
    const agentNickname = nullIfEmpty(thread.agentNickname)
    const agentRole = nullIfEmpty(thread.agentRole)
    const parentThreadId = thread.threadSource === 'subagent' ? thread.forkedFromId : null
    const source = parentThreadId
      ? {
          subAgent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: this.subagentDepth(thread),
              agent_path: null,
              agent_nickname: agentNickname,
              agent_role: agentRole,
            },
          },
        }
      : normalizeSessionSource(thread.source)
    const profileId =
      thread.sandboxMode === 'danger-full-access'
        ? ':danger-full-access'
        : thread.sandboxMode === 'read-only'
          ? ':read-only'
          : ':workspace'
    const section = thread.sectionId == null ? null : this.store.getSection(thread.sectionId)
    const isPinned = thread.sectionId === PINNED_SECTION_ID || thread.isPinned === true

    return {
      id: thread.id,
      historyMode: this.store.threadSettings(thread.id).historyMode ?? 'legacy',
      isPinned,
      section,
      sectionEnteredAt: thread.sectionEnteredAt ?? null,
      sessionId: thread.sessionId,
      forkedFromId: thread.forkedFromId,
      parentThreadId,
      preview: thread.preview,
      ephemeral: thread.ephemeral,
      modelProvider: thread.modelProvider,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      recencyAt: thread.updatedAt,
      status: thread.status,
      path: null,
      cwd: thread.cwd,
      cliVersion: codexCliVersion(),
      canAcceptDirectInput: true,
      activePermissionProfile: profileId,
      // Defense-in-depth: even if older rows hold an invalid `source` or
      // `threadSource` (legacy `app_server`, empty string from a buggy write
      // path), coerce on the way out so the App's strict deserializer never
      // sees a value outside the wire enum.
      source,
      threadSource: normalizeThreadSource(thread.threadSource),
      agentNickname,
      agentRole,
      gitInfo: this.store.threadSettings(thread.id).gitInfo ?? null,
      name: thread.name,
      turns: turns.map((turn) => this.toTurn(turn)),
    }
  }

  private subagentDepth(thread: ThreadRecord): number {
    let depth = thread.threadSource === 'subagent' ? 1 : 0
    let ancestorId = thread.forkedFromId
    const seen = new Set([thread.id])
    while (ancestorId && !seen.has(ancestorId)) {
      seen.add(ancestorId)
      const ancestor = this.store.getThread(ancestorId)
      if (!ancestor || ancestor.threadSource !== 'subagent') break
      depth += 1
      ancestorId = ancestor.forkedFromId
    }
    return depth
  }

  // Full turn payload for history reads (thread/read, turns/list) — carries the
  // loaded items. The Codex v2 `Turn` schema has no api/cost metadata fields, so
  // the adapter's internal metrics are not serialized onto the wire.
  private toTurn(turn: TurnRecord): unknown {
    return {
      id: turn.id,
      items: turn.items,
      itemsView: 'full',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  private toTurnView(turn: TurnRecord, itemsView: TurnItemsView): unknown {
    if (itemsView === 'full') return this.toTurn(turn)
    if (itemsView === 'notLoaded') return this.toLifecycleTurn(turn)
    const firstUser = turn.items.find((item) => item.type === 'userMessage')
    const lastAgent = turn.items.findLast((item) => item.type === 'agentMessage')
    const items: ThreadItem[] = []
    if (firstUser) items.push(firstUser)
    if (lastAgent && lastAgent.id !== firstUser?.id) items.push(lastAgent)
    return {
      id: turn.id,
      items,
      itemsView: 'summary',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  // Lightweight payload for turn/start, turn/started, and terminal paths that
  // intentionally do not carry an assistant summary. The item stream drives
  // the timeline; completed subagent turns use toCompletedTurn below.
  private toLifecycleTurn(turn: TurnRecord, items: ThreadItem[] = []): unknown {
    return {
      id: turn.id,
      items,
      itemsView: 'notLoaded',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  // Codex includes the final assistant message in successful turn/completed
  // notifications. Subagent pages depend on that summary because they can be
  // opened with a metadata-only thread/read and may not replay prior deltas.
  private toCompletedTurn(turn: TurnRecord): unknown {
    const lastAgent =
      turn.status === 'completed' && turn.error == null
        ? turn.items.findLast((item) => item.type === 'agentMessage' && item.text.trim().length > 0)
        : undefined
    return {
      id: turn.id,
      items: lastAgent ? [lastAgent] : [],
      itemsView: lastAgent ? 'summary' : 'notLoaded',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  private sendResponse(
    peer: RpcPeer,
    id: JsonRpcId,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
    const response: JsonRpcResponse = { jsonrpc: '2.0', id }
    if (error) response.error = error
    else response.result = result ?? null
    peer.send(response)
  }

  private notify(peer: RpcPeer, notification: { method: string; params: unknown }): void {
    // Shutdown intentionally suppresses wire notifications: the peer may
    // already have closed, while persistence still needs to settle child and
    // parent state without throwing on a broken pipe.
    if (this.stopped) return
    const params = asRecord(notification.params)
    const turnId = stringOr(params.turnId, '')
    const itemId = stringOr(asRecord(params.item).id, '')
    if (notification.method === 'item/started' && turnId && itemId) {
      const items = this.activeItemsByTurn.get(turnId) ?? new Set<string>()
      items.add(itemId)
      this.activeItemsByTurn.set(turnId, items)
    } else if (notification.method === 'item/completed') {
      this.activeItemsByTurn.get(turnId)?.delete(itemId)
    } else if (notification.method === 'turn/completed') {
      const turn = asRecord(params.turn)
      const completedId = stringOr(turn.id, '')
      if (turn.status === 'interrupted' || turn.status === 'failed')
        this.finishAbortedItems(peer, stringOr(params.threadId, ''), completedId)
      this.activeItemsByTurn.delete(completedId)
    }
    const target = this.peerForParams(peer, notification.params)
    debugLog('rpc.notify', {
      peerId: target.id,
      originalPeerId: target.id === peer.id ? null : peer.id,
      method: notification.method,
      params: summarizeRpcParams(notification.method, notification.params),
    })
    target.send({ jsonrpc: '2.0', method: notification.method, params: notification.params })
  }

  private finishAbortedItems(peer: RpcPeer, threadId: string, turnId: string): void {
    const active = this.activeItemsByTurn.get(turnId)
    const turn = this.store.getTurn(turnId)
    if (!active || !turn) return
    const message = '回合已终止；未确认的工具结果不能重放'
    for (const item of turn.items) {
      if (!active.has(item.id)) continue
      let completed: ThreadItem = item
      if (item.type === 'dynamicToolCall')
        completed = {
          ...item,
          status: 'failed',
          success: false,
          contentItems: [{ type: 'inputText', text: message }],
        }
      else if (item.type === 'mcpToolCall')
        completed = { ...item, status: 'failed', error: { message } }
      else if ('status' in item && item.status === 'inProgress')
        completed = { ...item, status: 'failed' }
      this.store.updateItem(turnId, item.id, () => completed)
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId, turnId, item: completed, completedAtMs: nowMillis() },
      })
    }
  }

  private notifyThread(threadId: string, notification: { method: string; params: unknown }): void {
    const peer = this.activePeerByThread.get(threadId)
    if (peer) this.notify(peer, notification)
  }

  private setThreadStatus(
    peer: RpcPeer | null,
    threadId: string,
    status: ThreadRecord['status'],
  ): void {
    this.store.updateThreadStatus(threadId, status)
    const target = peer ?? this.activePeerByThread.get(threadId)
    if (target)
      this.notify(target, { method: 'thread/status/changed', params: { threadId, status } })
  }

  private sendServerRequest(
    peer: RpcPeer,
    method: string,
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const target = this.peerForParams(peer, params)
    const threadId = stringOr(asRecord(params).threadId, '')
    return this.pendingInteractions.request(target, method, id, params, signal, () => {
      this.notify(target, {
        method: 'serverRequest/resolved',
        params: { threadId, requestId: id },
      })
    })
  }

  private completeActiveTurns(status: 'interrupted' | 'failed', error: unknown): void {
    for (const [threadId, turnId] of this.activeTurnByThread.entries()) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        this.store.completeTurn(turnId, status, error)
      }
      this.store.updateThreadStatus(threadId, { type: 'idle' })
    }
    this.activeTurnByThread.clear()
    for (const startup of this.runtimeReadyByTurn.values()) startup.resolve(false)
    this.runtimeReadyByTurn.clear()
  }

  private finalizeActiveSubagentsForShutdown(message: string): void {
    for (const [turnId, state] of this.subagentStateByTurn.entries()) {
      const turn = this.store.getTurn(turnId)
      if (!turn || turn.status !== 'inProgress') {
        this.subagentStateByTurn.delete(turnId)
        continue
      }
      const peer = this.activePeerByThread.get(state.thread.id) ?? {
        id: 'shutdown',
        send: () => {},
        close: () => {},
      }
      this.finalizeOrphanedSubagents(
        peer,
        state.thread,
        turn,
        state.contexts,
        state.active,
        message,
      )
      this.subagentStateByTurn.delete(turnId)
    }
  }

  private markActiveTurn(threadId: string, turnId: string): void {
    let resolve!: (started: boolean) => void
    const ready = new Promise<boolean>((done) => {
      resolve = done
    })
    this.runtimeReadyByTurn.set(turnId, { ready, resolve })
    this.activeTurnByThread.set(threadId, turnId)
  }

  private clearActiveTurn(threadId: string): void {
    const turnId = this.activeTurnByThread.get(threadId)
    if (turnId) {
      this.runtimeReadyByTurn.get(turnId)?.resolve(false)
      this.runtimeReadyByTurn.delete(turnId)
    }
    const existed = this.activeTurnByThread.delete(threadId)
    if (existed && this.activeTurnByThread.size === 0) this.idleCheckHandler?.()
  }

  private peerForParams(peer: RpcPeer, params: unknown): RpcPeer {
    const threadId = stringOr(asRecord(params).threadId, '')
    if (!threadId) return peer
    const direct = this.activePeerByThread.get(threadId)
    if (direct) return direct
    const seen = new Set<string>()
    let current = this.store.getThread(threadId)
    while (current?.forkedFromId && !seen.has(current.forkedFromId)) {
      seen.add(current.forkedFromId)
      const ancestorPeer = this.activePeerByThread.get(current.forkedFromId)
      if (ancestorPeer) {
        this.activePeerByThread.set(threadId, ancestorPeer)
        return ancestorPeer
      }
      current = this.store.getThread(current.forkedFromId)
    }
    return peer
  }

  private bindPeerToDescendants(peer: RpcPeer, rootThreadId: string): void {
    const queue = [rootThreadId]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const parentId = queue.shift()
      if (!parentId || seen.has(parentId)) continue
      seen.add(parentId)
      for (const child of this.store.listThreads({
        includeEphemeral: true,
        parentThreadId: parentId,
        sortKey: 'created_at',
        sortDirection: 'asc',
      })) {
        this.activePeerByThread.set(child.id, peer)
        queue.push(child.id)
      }
    }
  }

  private loadPersistedConfig(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as Record<string, unknown>
      let shouldRepair = false
      if (typeof parsed.model === 'string' && parsed.model.length > 0) {
        const normalized = normalizeSelectableModelId(parsed.model, this.configModel)
        shouldRepair = normalized !== parsed.model
        this.configModel = normalized
      }
      if (typeof parsed.model_reasoning_effort === 'string') {
        this.configReasoningEffort =
          normalizeCodexReasoningEffort(parsed.model_reasoning_effort) ?? this.configReasoningEffort
      }
      // Restore the overrides bag — any key persisted previously that isn't
      // the strongly-typed model / effort lives here so it survives restarts.
      if (
        parsed.overrides &&
        typeof parsed.overrides === 'object' &&
        !Array.isArray(parsed.overrides)
      ) {
        this.configOverrides = parsed.overrides as Record<string, unknown>
      }
      if (shouldRepair) this.persistConfig()
    } catch {}
  }

  private persistConfig(): void {
    try {
      ensureParent(this.configPath)
      writeFileSync(
        this.configPath,
        JSON.stringify(
          {
            model: this.configModel,
            model_reasoning_effort: this.configReasoningEffort,
            overrides: this.configOverrides,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
    } catch {}
  }
}
