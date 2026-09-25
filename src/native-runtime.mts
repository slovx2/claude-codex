import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Extended cache TTL for 1-hour prompt caching
if (!process.env.ANTHROPIC_BETAS) {
  process.env.ANTHROPIC_BETAS = 'extended-cache-ttl-2025-04-11'
} else if (!process.env.ANTHROPIC_BETAS.includes('extended-cache-ttl-2025-04-11')) {
  process.env.ANTHROPIC_BETAS = `${process.env.ANTHROPIC_BETAS},extended-cache-ttl-2025-04-11`
}

// In-process Claude runtime — replaces the Python sidecar entirely. Talks to
// @anthropic-ai/claude-agent-sdk directly so we get a single process boundary
// (Codex App ⇄ adapter), faster cold-starts, and no JSONL bridge to maintain.
//
// Surface contract: the same ClaudeRuntime shape the older sidecar-runtime
// implemented, so server.mts is unchanged.
//
// What this file preserves from the Python sidecar:
//   * subagent suppression state machine (active_subagent_ids)
//   * text/thinking stream-vs-block dedup — JS SDK re-delivers completed
//     content blocks after their streaming deltas
//   * ToolUseBlock double-delivery dedup (skip start, take from AssistantMessage)
//   * StructuredOutput synthetic-tool coercion
//   * derive_permission_mode mapping for (approvalPolicy, sandbox, planMode)
//   * multimodal user input (text + base64/url image blocks)
//
// What this file no longer needs (vs. Python):
//   * class_name / obj_get polymorphism — JS blocks have native block.type
//   * droppable_in_priority TypeError loop — JS Options is a stable type
//   * rate_limit_event parse-gap fallback — JS SDK first-class
//
// Auth: relies on the host having `claude` CLI auth set up (claude /login or
// ANTHROPIC_API_KEY). The SDK shells out to the bundled claude-code binary
// installed via optionalDependencies.

import type { OnElicitation, Query } from '@anthropic-ai/claude-agent-sdk'
import { type ApprovalPolicy, allowsApproval, toolApprovalFlow } from './approval-policy.mjs'
import { dynamicToolServer } from './dynamic-tools.mjs'
import { sdkMcpStartupEnvironment } from './mcp-config.mjs'
import { NativeMcpBridge } from './native-mcp-bridge.mjs'
import { NativeProcess, succeedsWithin } from './native-process.mjs'
import { NativeTurnInput } from './native-turn-input.mjs'
import { ProtocolError, submissionHash } from './protocol-contract.mjs'
import {
  deniedTool,
  isPlanFile,
  type OriginalBashInputs,
  planDirectory,
  runtimePermissionOptions,
  sandboxedBashInput,
} from './runtime-permissions.mjs'
import type {
  ClaudeRuntime,
  PermissionDecision,
  RuntimeHandlers,
  RuntimeTurnContext,
  UserInputAnswers,
  UserInputQuestion,
} from './types.mjs'
import { newId } from './util.mjs'
import { parseWorkflowCommand, workflowRuntimePrompt } from './workflow-command.mjs'
import {
  defaultWorkflowTranscriptRoots,
  parseWorkflowLaunchInfo,
  WorkflowJournalMonitor,
  type WorkflowLaunchInfo,
} from './workflow-subagents.mjs'

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')

interface PendingTurn {
  context: RuntimeTurnContext
  handlers: RuntimeHandlers
  query: Query
  abort: AbortController
  input: NativeTurnInput
  resolved: boolean
  resolve: () => void
  reject: (error: Error) => void
  // SDK assistant envelopes can deliver one content block at a time. Keep
  // dedup scoped to a model response, preserving unstreamed blocks alongside
  // streamed ones and emitting a boundary only when the message id changes.
  assistantMessageId: string | null
  streamedBlocks: Map<number, { type: string; text: string }>
  // Subagent suppression — when a Task/Agent tool_use opens a subagent, all
  // nested tool_use / text / thinking events should be hidden from the App
  // timeline until the matching tool_result closes the parent Task.
  activeSubagents: Set<string>
  completedWorkflowTasks: Set<string>
  workflowToolUseIds: Set<string>
  workflowLaunches: Map<string, WorkflowLaunchInfo>
  workflowTranscriptRoots: string[]
  skippedWorkflowTaskIds: Set<string>
  workflowTasks: Map<string, WorkflowTaskState>
  // Tool ids whose content_block_start we already saw — used to skip the
  // second delivery via AssistantMessage.content (the SDK ships every
  // ToolUseBlock twice; we keep only the AssistantMessage copy because
  // content_block_start arrives with empty input).
  toolStartSeen: Set<string>
  // Buffer + tool ids for StructuredOutput coercion: when the SDK ships a
  // synthetic StructuredOutput tool_use we want to suppress the streamed
  // text and emit only the final coerced JSON.
  structuredBuffer: string
  pendingUserMessage: null | { resolve: (v: { message: unknown }) => void }
  deferredResult: PendingTurnResult | null
  workflowFailure: string | null
}

interface PendingTurnResult {
  success: boolean
  resultText: string | null
  claudeSessionId: string | null
  inputReceipt: Record<string, unknown>
}

interface WorkflowTaskState {
  taskId: string
  toolUseId: string
  workflowName: string
  description: string
  prompt: string
  monitor: WorkflowJournalMonitor | null
  aggregateStarted: boolean
  terminal: boolean
  monitorFailed?: boolean
}

interface PendingPermission {
  resolve: (value: PermissionDecision) => void
}

const WORKFLOW_TERMINAL_FLUSH_TIMEOUT_MS = 500
const WORKFLOW_JOURNAL_SETTLE_TIMEOUT_MS = 3_000

export class NativeClaudeRuntime implements ClaudeRuntime {
  private sdk: ClaudeSdk | null = null
  private turns = new Map<string, PendingTurn>()
  private inputs = new Map<string, NativeTurnInput>()
  private permissions = new Map<string, PendingPermission>()
  private aborts = new Map<string, AbortController>()
  private cleanup = new Map<string, Promise<void>>()
  private processes = new Map<string, NativeProcess>()

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    if (this.processes.has(context.threadId))
      throw new ProtocolError(-32009, '上一个 Claude CLI 尚未确认退出，禁止启动新回合')
    let cleaned!: () => void
    const cleanup = new Promise<void>((resolve) => {
      cleaned = resolve
    })
    this.cleanup.set(context.threadId, cleanup)
    const input = new NativeTurnInput(this.buildPromptIterable(context))
    const abort = new AbortController()
    const mcp = new NativeMcpBridge()
    const nativeProcess = new NativeProcess(context.threadId, context.turnId)
    this.processes.set(context.threadId, nativeProcess)
    this.inputs.set(context.threadId, input)
    this.aborts.set(context.threadId, abort)
    try {
      const sdk = await this.loadSdk()
      if (input.isClosed) throw new ProtocolError(-32009, '原生回合启动已取消')
      const options = this.buildOptions(sdk, context, abort)
      options.spawnClaudeCodeProcess = nativeProcess.spawn.bind(nativeProcess)
      options.mcpServers = await mcp.connect(
        context.mcpServers,
        context.cwd,
        handlers,
        abort.signal,
      )
      if (input.isClosed) throw new ProtocolError(-32009, '原生回合启动已取消')
      return await new Promise<void>((resolve, reject) => {
        // The SDK accepts either a plain string prompt OR an AsyncIterable of
        // SDKUserMessage envelopes. Always feed the iterable form so we have
        // room to attach image blocks alongside the text and the door is open
        // for mid-turn steer() calls.
        if (context.dynamicTools?.length) {
          const nativeIds = new Map<string, string[]>()
          const hooks = options.hooks as { PreToolUse: Array<{ hooks: unknown[] }> }
          hooks.PreToolUse.push({
            hooks: [
              async (input: Record<string, unknown>, toolUseId: string) => {
                const key = `${input.tool_name}:${submissionHash(input.tool_input)}`
                const ids = nativeIds.get(key) ?? []
                ids.push(toolUseId)
                nativeIds.set(key, ids)
                return {}
              },
            ],
          })
          options.mcpServers = {
            ...((options.mcpServers as Record<string, unknown>) ?? {}),
            tyrs_hand: dynamicToolServer(context.dynamicTools, handlers, (name, args) => {
              const id = nativeIds.get(`mcp__tyrs_hand__${name}:${submissionHash(args)}`)?.shift()
              if (!id) throw new Error('缺少原生工具调用 ID，禁止执行副作用')
              return id
            }),
          }
        }

        const query = sdk.query({ prompt: input, options })
        const pending: PendingTurn = {
          context,
          handlers,
          query,
          abort,
          input,
          resolved: false,
          resolve,
          reject,
          assistantMessageId: null,
          streamedBlocks: new Map(),
          activeSubagents: new Set(),
          completedWorkflowTasks: new Set(),
          workflowToolUseIds: new Set(),
          workflowLaunches: new Map(),
          workflowTranscriptRoots: defaultWorkflowTranscriptRoots(process.env, context.cwd),
          skippedWorkflowTaskIds: new Set(),
          workflowTasks: new Map(),
          toolStartSeen: new Set(),
          structuredBuffer: '',
          pendingUserMessage: null,
          deferredResult: null,
          workflowFailure: null,
        }
        this.turns.set(context.turnId, pending)
        // Kick off the receive loop in the background. We don't await it here
        // because runTurn() must resolve when the result message arrives — the
        // receive loop will call resolve/reject on `pending` once the SDK ends.
        void this.consume(pending).catch((err: unknown) => {
          if (!pending.resolved) {
            pending.resolved = true
            this.turns.delete(context.turnId)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })
    } finally {
      input.close()
      if (this.inputs.get(context.threadId) === input) this.inputs.delete(context.threadId)
      if (this.aborts.get(context.threadId) === abort) this.aborts.delete(context.threadId)
      let stopped = false
      try {
        try {
          await mcp.close()
        } finally {
          if (!(await nativeProcess.wait(3_000))) await nativeProcess.terminate()
          stopped = true
        }
      } finally {
        if (stopped && this.processes.get(context.threadId) === nativeProcess)
          this.processes.delete(context.threadId)
        if (this.cleanup.get(context.threadId) === cleanup) this.cleanup.delete(context.threadId)
        cleaned()
      }
    }
  }

  async steer(threadId: string, prompt: string): Promise<void> {
    const input = this.inputs.get(threadId)
    if (!input) throw new ProtocolError(-32009, '原生回合未启动或已结束')
    input.steer(workflowRuntimePrompt(prompt))
  }

  async forkSession(sessionId: string, cwd: string, upToMessageId?: string): Promise<string> {
    const sdk = await this.loadSdk()
    const result = await sdk.forkSession(sessionId, {
      dir: cwd,
      ...(upToMessageId ? { upToMessageId } : {}),
    })
    return result.sessionId
  }

  async interrupt(threadId: string): Promise<void> {
    const cleanup = this.cleanup.get(threadId)
    const pending = [...this.turns.values()].find((turn) => turn.context.threadId === threadId)
    // SDK 的 abort 先关闭 stdin，CLI 仍有退出宽限期；此时释放 MCP
    // 会把错误工具结果送回尚未中断的模型循环。先等待 CLI 确认中断。
    const nativeProcess = this.processes.get(threadId)
    if (pending && !(await succeedsWithin(pending.query.interrupt(), 1_500)))
      await nativeProcess?.terminate()
    this.inputs.get(threadId)?.close()
    this.aborts.get(threadId)?.abort()
    if (pending) await this.stopWorkflowTasks(pending)
    if (nativeProcess && !(await nativeProcess.wait(2_500))) await nativeProcess.terminate()
    await cleanup
    if (this.processes.get(threadId) === nativeProcess) this.processes.delete(threadId)
  }

  async stop(): Promise<void> {
    const threads = new Set([...this.cleanup.keys(), ...this.processes.keys()])
    await Promise.all([...threads].map((threadId) => this.interrupt(threadId)))
    this.turns.clear()
    this.permissions.clear()
  }

  // ── private ──

  private async loadSdk(): Promise<ClaudeSdk> {
    if (this.sdk) return this.sdk
    // Dynamic import keeps the heavy native binary out of the require graph
    // until a real runtime turn is requested (mocked tests don't pay for it).
    this.sdk = await import('@anthropic-ai/claude-agent-sdk')
    return this.sdk
  }

  private buildPromptIterable(context: RuntimeTurnContext): AsyncIterable<any> {
    const text = workflowRuntimePrompt(context.prompt)
    const images = context.imageInputs
    return (async function* () {
      if (!images || images.length === 0) {
        // Pure text — keep the simple string form so the SDK doesn't have to
        // re-stitch content blocks.
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: text },
          parent_tool_use_id: null,
          origin: { kind: 'human' as const },
        }
        return
      }
      // Multimodal — assemble the Anthropic MessageParam content array.
      const content: unknown[] = []
      if (text) content.push({ type: 'text', text })
      for (const img of images) {
        if (img.kind === 'base64') {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          })
        } else {
          content.push({
            type: 'image',
            source: { type: 'url', url: img.data },
          })
        }
      }
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content },
        parent_tool_use_id: null,
        origin: { kind: 'human' as const },
      }
    })()
  }

  private buildOptions(
    sdk: ClaudeSdk,
    context: RuntimeTurnContext,
    abort: AbortController,
  ): Record<string, unknown> {
    const originalBashInputs: OriginalBashInputs = new Map()
    const opts: Record<string, unknown> = {
      abortController: abort,
      includePartialMessages: true,
      includeHookEvents: true,
      cwd: context.cwd,
      settingSources: ['user', 'project', 'local'],
      // 失败后由持久化状态对账；禁止 CLI 自行重放可能已接收的模型请求。
      env: {
        ...process.env,
        ...sdkMcpStartupEnvironment(context.mcpServers),
        CLAUDE_CODE_MAX_RETRIES: '0',
      },
      ...runtimePermissionOptions(context, originalBashInputs),
      settings: { plansDirectory: relative(context.cwd, planDirectory(context)) },
      disallowedTools: ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'],
      stderr: (data: string) => process.stderr.write(data),
      onElicitation: (async (request, { signal }) => {
        const pending = this.turns.get(context.turnId)
        if (signal.aborted || !pending?.handlers.onElicitationRequest) return { action: 'cancel' }
        try {
          return await pending.handlers.onElicitationRequest(request, signal)
        } catch (error) {
          if (signal.aborted || abort.signal.aborted) return { action: 'cancel' }
          throw error
        }
      }) satisfies OnElicitation,
      ...(process.env.CLAUDE_CODEX_SDK_DEBUG === '1' ? { debug: true } : {}),
    }
    if (context.model) opts.model = context.model
    if (context.effort) opts.effort = context.effort
    const resume = sdkResumeSessionId(context.claudeSessionId, context.cwd)
    if (resume) opts.resume = resume
    if (resume && context.forkSession) opts.forkSession = true

    // Ensure extended cache TTL is explicitly requested
    if (!process.env.ANTHROPIC_BETAS) {
      process.env.ANTHROPIC_BETAS = 'extended-cache-ttl-2025-04-11'
    }
    if (context.addDirs && context.addDirs.length > 0) opts.additionalDirectories = context.addDirs
    if (context.allowedTools && context.allowedTools.length > 0)
      opts.allowedTools = context.allowedTools
    if (context.outputFormat) opts.outputFormat = context.outputFormat

    // 完全访问由回调授权，支持 root 部署且保留计划确认和用户提问。
    const mode = derivePermissionMode(context.approvalPolicy, context.sandboxMode, context.planMode)
    opts.permissionMode = mode
    const permissionHooks = opts.hooks as { PreToolUse: Array<{ hooks: unknown[] }> }
    permissionHooks.PreToolUse.push({
      hooks: [
        async (event: Record<string, unknown>, toolUseId: string) => {
          const sessionId = String(event.session_id ?? '')
          const deadline = Date.now() + 3_000
          try {
            do {
              abort.signal.throwIfAborted()
              const messages =
                typeof event.agent_id === 'string'
                  ? await sdk.getSubagentMessages(sessionId, event.agent_id, { dir: context.cwd })
                  : await sdk.getSessionMessages(sessionId, { dir: context.cwd })
              if (
                messages.some((entry) => {
                  const content = (entry.message as { content?: unknown })?.content
                  return (
                    Array.isArray(content) &&
                    content.some((block) => block?.type === 'tool_use' && block.id === toolUseId)
                  )
                })
              )
                return {}
              await delay(25, undefined, { signal: abort.signal })
            } while (Date.now() < deadline)
          } catch {
            // Hook 抛错只会被 CLI 记录，必须显式 deny 才能阻止工具。
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: '原生工具意图未能确认落盘或回合已取消，禁止执行。',
            },
          }
        },
      ],
    })

    if (parseWorkflowCommand(context.prompt)?.type === 'run') {
      opts.settings = {
        ...((opts.settings as Record<string, unknown> | undefined) ?? {}),
        enableWorkflows: true,
        workflowKeywordTriggerEnabled: true,
      }
    }

    // 即使完全访问也保留提问与计划确认；只对明确的完全访问组合自动授权。
    opts.canUseTool = this.makeCanUseTool(
      context,
      context.approvalPolicy === 'never' && context.sandboxMode === 'danger-full-access',
      originalBashInputs,
    )
    const hooks = opts.hooks as Record<string, unknown>
    hooks.PostToolUse = [
      {
        matcher: 'EnterPlanMode|ExitPlanMode|Write|Edit',
        hooks: [
          async (event: Record<string, unknown>) => {
            const pending = this.turns.get(context.turnId)
            if (!pending || pending.abort.signal.aborted || event.agent_id) return {}
            const input = (event.tool_input ?? {}) as Record<string, unknown>
            if (isPlanFile(context, String(event.tool_name), input)) {
              await pending.handlers.onEvent({
                type: 'plan_text',
                text: readFileSync(String(input.file_path), 'utf8'),
              })
              return {}
            }
            if (event.tool_name !== 'EnterPlanMode' && event.tool_name !== 'ExitPlanMode') return {}
            const enabled = event.tool_name === 'EnterPlanMode'
            await pending.query.setPermissionMode(
              derivePermissionMode(context.approvalPolicy, context.sandboxMode, enabled),
            )
            context.planMode = enabled
            await pending.handlers.onEvent({ type: 'plan_mode', enabled })
            return {}
          },
        ],
      },
    ]

    // Project + developer + personality instructions ride along as a system
    // prompt append, preserving Claude Code's built-in preset.
    // Re-render on resume so settings changes (including clearing an append)
    // take effect on the next turn instead of waiting for SDK compaction.
    opts.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      snapshot: false,
      ...(context.systemPromptAddendum?.trim()
        ? { append: context.systemPromptAddendum.trim() }
        : {}),
    }

    // CLI binary override (for users pinning a specific claude-code build).
    if (process.env.CLAUDE_CODEX_CLI) throw new Error('必须使用固定 SDK 随包的 Claude CLI')

    void sdk // keep parameter referenced for future SDK-version-gated options
    return opts
  }

  private makeCanUseTool(
    context: RuntimeTurnContext,
    autoAllow: boolean,
    originalBashInputs: OriginalBashInputs = new Map(),
  ) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        toolUseID?: string
        signal: AbortSignal
        agentID?: string
        matchedAskRule?: unknown
      },
    ): Promise<
      { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string }
    > => {
      const toolUseId = options.toolUseID || `tool-${newId()}`
      const pending = this.turns.get(context.turnId)
      if (!pending) return { behavior: 'deny', message: 'turn already finished' }

      // 用 SDK 正式的 updatedInput 返回答案，不能伪装成工具拒绝。
      if (toolName === 'AskUserQuestion') {
        try {
          const requestId = `${context.threadId}:${context.turnId}:askq:${toolUseId}`
          const questions = parseAskUserQuestions(input)
          if (questions.length === 0) {
            return { behavior: 'deny', message: 'no questions provided' }
          }
          if (typeof pending.handlers.onUserInputRequest !== 'function') {
            return { behavior: 'deny', message: 'user input not available in this runtime' }
          }
          const answers = await pending.handlers.onUserInputRequest({
            type: 'user_input_request',
            requestId,
            toolUseId,
            questions,
          })
          if (options.signal.aborted) return { behavior: 'deny', message: '提问已取消' }
          const formatted = formatAskUserQuestionAnswers(input, questions, answers)
          return { behavior: 'allow', updatedInput: JSON.parse(formatted) }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { behavior: 'deny', message: `AskUserQuestion failed: ${msg}` }
        }
      }

      if (options.agentID && (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode'))
        return { behavior: 'deny', message: '子代理不能修改父会话的计划模式' }
      if (toolName === 'EnterPlanMode') return { behavior: 'allow', updatedInput: input }
      if (toolName === 'ExitPlanMode') {
        const answers = await pending.handlers.onUserInputRequest?.({
          type: 'user_input_request',
          toolName: 'ExitPlanMode',
          requestId: `${context.turnId}:exit-plan:${toolUseId}`,
          toolUseId,
          questions: [
            {
              id: 'execute_plan',
              header: '执行计划',
              question: '计划已完成，是否退出计划模式并按当前权限执行？',
              isOther: true,
              isSecret: false,
              options: [
                { label: '执行计划', description: '退出计划模式，继续执行已确认的计划。' },
                { label: '继续规划', description: '保持计划模式，不执行修改。' },
              ],
            },
          ],
        })
        if (options.signal.aborted || answers?.answers.execute_plan?.answers.join() !== '执行计划')
          return { behavior: 'deny', message: '用户尚未确认执行，继续保持计划模式。' }
        return { behavior: 'allow', updatedInput: input }
      }
      if (isPlanFile(context, toolName, input)) return { behavior: 'allow', updatedInput: input }
      if (
        toolName === 'Bash' &&
        originalBashInputs.has(toolUseId) &&
        context.approvalPolicy !== 'untrusted' &&
        (context.planMode || context.sandboxMode === 'read-only')
      )
        return { behavior: 'allow', updatedInput: input }
      if (context.planMode && !(toolName === 'Bash' && originalBashInputs.has(toolUseId)))
        return { behavior: 'deny', message: '计划模式不能执行副作用' }
      if (autoAllow) return { behavior: 'allow', updatedInput: input }
      if (
        !allowsApproval(
          context.approvalPolicy,
          options.matchedAskRule ? 'rules' : toolApprovalFlow(toolName),
        )
      )
        return { behavior: 'deny', message: '当前审批策略禁止发起此类权限请求' }

      const requestId = `${context.threadId}:${context.turnId}:${toolName}:${toolUseId}`
      // Subagent-aware approval suppression: when Claude is mid-subagent we
      // still want THIS tool to be approved by the user (otherwise nested
      // tools would silently bypass approval). The server-side already
      // routes everything through onPermissionRequest; nothing to change here.
      const decision = await new Promise<PermissionDecision>((resolve) => {
        const cancelled = () => finish({ decision: 'cancel' })
        const finish = (value: PermissionDecision) => {
          this.permissions.delete(requestId)
          options.signal.removeEventListener('abort', cancelled)
          resolve(value)
        }
        this.permissions.set(requestId, { resolve: finish })
        if (options.signal.aborted) {
          cancelled()
          return
        }
        options.signal.addEventListener('abort', cancelled, { once: true })
        void Promise.resolve()
          .then(() =>
            pending.handlers.onPermissionRequest({
              type: 'permission_request',
              requestId,
              toolUseId,
              toolName,
              input: originalBashInputs.get(toolUseId) ?? input,
            }),
          )
          .then(finish, () => finish({ decision: 'decline' }))
      })

      if (decision.decision === 'accept' || decision.decision === 'acceptForSession') {
        if (decision.updatedInput) {
          const updated = decision.updatedInput as Record<string, unknown>
          const reason = deniedTool(context, toolName, updated)
          if (reason) return { behavior: 'deny', message: reason }
          return {
            behavior: 'allow',
            updatedInput: toolName === 'Bash' ? sandboxedBashInput(context, updated) : updated,
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
      }
      return { behavior: 'deny', message: 'denied by user' }
    }
  }

  private async consume(pending: PendingTurn): Promise<void> {
    const { context, handlers, query } = pending
    try {
      for await (const message of query as AsyncIterable<Record<string, unknown>>) {
        if (
          (message.type === 'assistant' || message.type === 'user') &&
          !message.parent_tool_use_id &&
          typeof message.uuid === 'string'
        ) {
          await handlers.onEvent({ type: 'native_boundary', messageId: message.uuid })
        }
        await this.handleMessage(pending, message)
        if (pending.resolved) break
      }
      if (!pending.resolved && pending.deferredResult) {
        // The SDK iterator is the authoritative lifetime of a turn. If it
        // closes while a workflow journal still has an unresolved task, there
        // will be no later task_notification to unblock the deferred result.
        // Close those projected agents as failed and finish the parent turn
        // rather than leaving Codex cc's spinner alive forever.
        if (this.hasPendingWorkflowTasks(pending)) await this.stopWorkflowTasks(pending)
        await this.finishDeferredResult(pending, true)
        if (!pending.resolved) return
      }
      // The async iterator finished without a 'result' message — treat as
      // successful empty turn (claude-agent-sdk does occasionally end without
      // a SDKResultMessage when interrupted cleanly).
      if (!pending.resolved) {
        await this.stopWorkflowTasks(pending)
        pending.resolved = true
        this.turns.delete(context.turnId)
        try {
          await handlers.onEvent({
            type: 'completed',
            success: false,
            result: 'SDK 未返回终态，执行结果不确定，请读取历史对账',
          })
          pending.resolve()
        } catch (err) {
          pending.reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
    } catch (err) {
      if (!pending.resolved) {
        await this.stopWorkflowTasks(pending)
        pending.resolved = true
        this.turns.delete(context.turnId)
        const error = err instanceof Error ? err : new Error(String(err))
        try {
          await handlers.onEvent({ type: 'error', message: error.message })
        } catch {}
        pending.reject(error)
      }
    }
  }

  private async handleMessage(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const type = String(message.type ?? '')
    switch (type) {
      case 'system':
        await this.handleSystem(pending, message)
        break
      case 'stream_event':
        await this.handleStreamEvent(pending, message)
        break
      case 'assistant':
        await this.handleAssistant(pending, message)
        break
      case 'user':
        await this.handleUser(pending, message)
        break
      case 'result':
        await this.handleResult(pending, message)
        break
      default:
        // Hook events, rate-limit notifications, etc. Many of them surface as
        // their own SDKMessage variants in recent SDK builds. Convert to a
        // generic notice + (for hook events) a structured hook event so the
        // server can render a hookPrompt timeline item.
        await this.handleOther(pending, type, message)
    }
  }

  private async handleSystem(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const subtype = String(message.subtype ?? '')
    if (subtype === 'compact_boundary') {
      await pending.handlers.onEvent({
        type: 'context_compacted',
        messageId: String(message.uuid ?? ''),
      })
      return
    }
    if (subtype === 'init') {
      const sessionId = String(message.session_id ?? '')
      if (sessionId) await pending.handlers.onEvent({ type: 'session', claudeSessionId: sessionId })
      return
    }
    if (subtype === 'permission_denied') {
      // The SDK auto-denied a tool call (auto-mode classifier, deny rule, etc).
      // Surface as a notice so the user sees why nothing happened.
      const toolName = String((message as Record<string, unknown>).tool_name ?? 'tool')
      await pending.handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: `Permission denied for ${toolName}`,
      })
      return
    }
    if (subtype === 'task_started' && isWorkflowBackgroundTask(message)) {
      const taskId = String(message.task_id ?? '')
      if (!taskId) return
      const sourceToolUseId = String(message.tool_use_id ?? '')
      if (message.skip_transcript === true) {
        const skipped =
          pending.skippedWorkflowTaskIds ?? (pending.skippedWorkflowTaskIds = new Set())
        skipped.add(taskId)
        this.discardDeferredWorkflowLaunches(pending, taskId, sourceToolUseId)
        const hiddenState = pending.workflowTasks?.get(taskId)
        if (hiddenState) {
          hiddenState.terminal = true
          await hiddenState.monitor?.stop()
          await this.closeWorkflowAgentLifecycles(
            pending,
            hiddenState,
            'Workflow transcript was hidden before the agent completed.',
            false,
          )
          await this.closeWorkflowAggregateLifecycle(
            pending,
            hiddenState,
            'Workflow transcript was hidden.',
            false,
          )
        }
        await this.finishDeferredResult(pending)
        return
      }
      const toolUseId = workflowTaskToolUseId(taskId)
      if (pending.completedWorkflowTasks.has(toolUseId)) return
      const state = this.ensureWorkflowTask(pending, taskId)
      if (sourceToolUseId && !state.toolUseId) state.toolUseId = sourceToolUseId
      state.workflowName = String(message.workflow_name ?? '').trim() || state.workflowName
      state.description = String(message.description ?? '').trim() || state.description
      state.prompt =
        String(message.prompt ?? '').trim() ||
        state.prompt ||
        state.description ||
        state.workflowName
      this.attachDeferredWorkflowJournal(pending, state, sourceToolUseId)
      return
    }
    if (subtype === 'task_notification') {
      const taskId = String(message.task_id ?? '')
      if (!taskId) return
      const knownState = pending.workflowTasks?.get(taskId)
      const hasWorkflowHint =
        isWorkflowBackgroundTask(message) || String(message.workflow_name ?? '').trim().length > 0
      const sourceToolUseId = String(message.tool_use_id ?? '')
      const hasPendingWorkflowLaunch = [...(pending.workflowLaunches?.values() ?? [])].some(
        (launch) => launch.taskId === taskId,
      )
      const hasPendingWorkflowTool =
        sourceToolUseId.length > 0 && pending.workflowToolUseIds?.has(sourceToolUseId) === true
      // The SDK's task_notification shape does not require task_type or
      // workflow_name. Once this turn has a matching launch/tool id, the task
      // is already proven to be a Workflow and the terminal notification must
      // not be discarded just because optional hints are absent.
      if (!knownState && !hasWorkflowHint && !hasPendingWorkflowLaunch && !hasPendingWorkflowTool)
        return
      if (pending.skippedWorkflowTaskIds?.has(taskId)) {
        this.discardDeferredWorkflowLaunches(pending, taskId, '')
        const hiddenState = pending.workflowTasks?.get(taskId)
        if (hiddenState) {
          hiddenState.terminal = true
          await hiddenState.monitor?.stop()
          await this.closeWorkflowAgentLifecycles(
            pending,
            hiddenState,
            'Workflow transcript was hidden before the agent completed.',
            false,
          )
          await this.closeWorkflowAggregateLifecycle(
            pending,
            hiddenState,
            'Workflow transcript was hidden.',
            false,
          )
        }
        await this.finishDeferredResult(pending)
        return
      }
      let state = knownState
      if (!state) {
        // Claude can emit task_notification before task_started (especially
        // after a reconnect or when the SDK batches system events). Create the
        // projected state from the notification instead of dropping the only
        // terminal signal and leaving the parent deferred forever.
        state = this.ensureWorkflowTask(pending, taskId)
        if (sourceToolUseId && !state.toolUseId) state.toolUseId = sourceToolUseId
        state.workflowName = String(message.workflow_name ?? '').trim() || state.workflowName
        state.description = String(message.description ?? '').trim() || state.description
        state.prompt =
          String(message.prompt ?? '').trim() ||
          state.prompt ||
          state.description ||
          state.workflowName
        this.attachDeferredWorkflowJournal(pending, state, sourceToolUseId)
      }
      if (message.skip_transcript === true) {
        const skipped =
          pending.skippedWorkflowTaskIds ?? (pending.skippedWorkflowTaskIds = new Set())
        skipped.add(taskId)
        this.discardDeferredWorkflowLaunches(pending, taskId, state.toolUseId)
        state.terminal = true
        await state.monitor?.stop()
        await this.closeWorkflowAgentLifecycles(
          pending,
          state,
          'Workflow transcript was hidden before the agent completed.',
          false,
        )
        await this.closeWorkflowAggregateLifecycle(
          pending,
          state,
          'Workflow transcript was hidden.',
          false,
        )
        await this.finishDeferredResult(pending)
        return
      }
      const toolUseId = workflowTaskToolUseId(taskId)
      if (pending.completedWorkflowTasks.has(toolUseId)) {
        state.terminal = true
        await this.finishDeferredResult(pending)
        return
      }
      const status = String(message.status ?? '')
      const summary = String(message.summary ?? '').trim() || `Workflow ${status || 'finished'}`
      const usage = workflowTaskUsage(message.usage)
      const trailer = usage
        ? `\n<usage>total_tokens: ${usage.totalTokens}\ntool_uses: ${usage.toolUses}\nduration_ms: ${usage.durationMs}</usage>`
        : ''
      const monitor = state.monitor
      let monitorStopped = false
      if (monitor && !state.aggregateStarted && !state.monitorFailed) {
        await settlesWithin(monitor.flush(), WORKFLOW_TERMINAL_FLUSH_TIMEOUT_MS)
        // onError can replace state.monitor while flush() is awaiting I/O.
        // Continue through the aggregate fallback in that case; never
        // dereference the mutable field after an await.
        if (state.monitor === monitor && !state.monitorFailed) {
          await monitor.drain(WORKFLOW_JOURNAL_SETTLE_TIMEOUT_MS)
        }
        if (state.monitor === monitor && !state.monitorFailed) {
          const projectedBeforeStop = this.workflowProjectedAgentIds(pending, state)
          if (monitor.startedCount > 0 || projectedBeforeStop.length > 0) {
            state.terminal = true
          }
          await monitor.stop()
          monitorStopped = true
          const projectedAgentIds = this.workflowProjectedAgentIds(pending, state)
          // A terminal notification owns this monitor even when the journal
          // yielded no agents. Clear the state before the aggregate fallback
          // so a late read or poll cannot keep the parent looking active.
          if (state.monitor === monitor) state.monitor = null
          if (monitor.startedCount > 0 || projectedAgentIds.length > 0) {
            state.terminal = true
            await this.closeWorkflowAgentLifecycles(
              pending,
              state,
              status === 'completed'
                ? `Workflow completed before the individual transcript result became visible.\n${summary}`
                : `Workflow ended before the agent published an individual result.\n${summary}`,
              status !== 'completed',
            )
            pending.completedWorkflowTasks.add(toolUseId)
            await pending.handlers.onEvent({
              type: 'notice',
              level: status === 'completed' ? 'info' : 'warning',
              message: `${state.workflowName || `Workflow ${taskId}`}: ${summary}${trailer}`,
            })
            await this.finishDeferredResult(pending)
            return
          }
        }
      }
      // If monitor failure raced with flush/drain, the error path has already
      // detached the monitor. Stop the snapshot defensively as well; stop is
      // idempotent and this closes the only remaining polling handle.
      if (monitor && !monitorStopped && (state.monitor !== monitor || state.monitorFailed)) {
        await monitor.stop()
      }

      await this.ensureWorkflowAggregateStarted(pending, state)
      if (!pending.activeSubagents.delete(toolUseId)) return
      pending.completedWorkflowTasks.add(toolUseId)
      state.terminal = true
      await pending.handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `${summary}${trailer}`,
        isError: status !== 'completed',
      })
      await this.finishDeferredResult(pending)
    }
  }

  private async handleStreamEvent(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const event = message.event as Record<string, unknown> | undefined
    if (!event) return
    if (message.parent_tool_use_id || pending.activeSubagents.size > 0) return
    const eventType = String(event.type ?? '')
    if (eventType === 'message_start') {
      const inner = event.message as Record<string, unknown> | undefined
      await this.beginAssistantMessage(pending, stringOrNull(inner?.id), true)
      return
    }
    if (eventType === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      if (block && String(block.type) === 'tool_use') {
        const id = String(block.id ?? '')
        // Skip the start envelope for tool_use — input is empty here and the
        // full block lands later inside the AssistantMessage. Without this
        // we'd emit one orphan inProgress item per tool and a real one.
        if (id) pending.toolStartSeen.add(id)
      }
      return
    }
    if (eventType === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      if (!delta) return
      const deltaType = String(delta.type ?? '')
      if (deltaType === 'text_delta') {
        const text = String(delta.text ?? '')
        if (!text) return
        this.recordStreamedBlock(pending, event.index, 'text', text)
        // Special-case: StructuredOutput synthetic tool buffers text and emits
        // only the final coerced JSON; suppress raw deltas while it's active.
        if (pending.context.outputFormat) {
          pending.structuredBuffer += text
          return
        }
        await pending.handlers.onEvent({ type: 'text_delta', delta: text })
      } else if (deltaType === 'thinking_delta') {
        const thinking = String(delta.thinking ?? '')
        if (!thinking) return
        this.recordStreamedBlock(pending, event.index, 'thinking', thinking)
        await pending.handlers.onEvent({ type: 'reasoning_delta', delta: thinking })
      }
    }
  }

  private async beginAssistantMessage(
    pending: PendingTurn,
    messageId: string | null,
    streamStart = false,
  ): Promise<void> {
    if (messageId ? messageId === pending.assistantMessageId : !streamStart) return
    pending.assistantMessageId = messageId
    pending.streamedBlocks = new Map()
    if (!pending.context?.outputFormat) {
      await pending.handlers.onEvent({ type: 'message_boundary' })
    }
  }

  private recordStreamedBlock(
    pending: PendingTurn,
    index: unknown,
    type: string,
    text: string,
  ): void {
    const blockIndex = typeof index === 'number' ? index : 0
    const blocks = (pending.streamedBlocks ??= new Map())
    const previous = blocks.get(blockIndex)
    blocks.set(blockIndex, { type, text: (previous?.type === type ? previous.text : '') + text })
  }

  private unstreamedBlockText(pending: PendingTurn, type: string, text: string): string {
    for (const [index, block] of pending.streamedBlocks ?? []) {
      if (block.type !== type || !text.startsWith(block.text)) continue
      pending.streamedBlocks.delete(index)
      return text.slice(block.text.length)
    }
    return text
  }

  private async handleAssistant(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const inner = message.message as Record<string, unknown> | undefined
    if (!inner) return
    const nestedMessage = Boolean(message.parent_tool_use_id)
    if (!nestedMessage && pending.activeSubagents.size === 0) {
      await this.beginAssistantMessage(pending, stringOrNull(inner.id))
    }
    const content = (inner.content as Array<Record<string, unknown>>) || []
    for (const block of content) {
      const blockType = String(block.type ?? '')
      if (blockType === 'text') {
        if (nestedMessage || pending.activeSubagents.size > 0) continue
        const text = this.unstreamedBlockText(pending, 'text', String(block.text ?? ''))
        if (pending.context?.outputFormat) {
          pending.structuredBuffer += text
        } else if (text) {
          await pending.handlers.onEvent({ type: 'text_delta', delta: text })
        }
      } else if (blockType === 'thinking') {
        if (nestedMessage || pending.activeSubagents.size > 0) continue
        const thinking = this.unstreamedBlockText(pending, 'thinking', String(block.thinking ?? ''))
        if (thinking) await pending.handlers.onEvent({ type: 'reasoning_delta', delta: thinking })
      } else if (blockType === 'tool_use') {
        const id = String(block.id ?? '')
        const name = String(block.name ?? '')
        const input = (block.input as Record<string, unknown>) || {}
        if (!id) continue
        // Suppress nested tool uses while a subagent is in flight.
        const parentSubagent = nestedMessage || pending.activeSubagents.size > 0
        if (isSubagentTool(name)) {
          pending.activeSubagents.add(id)
        }
        if (parentSubagent && !isSubagentTool(name)) continue
        if (name === 'StructuredOutput') {
          // Defer emission; the final coercion happens at result-time.
          continue
        }
        if (name === 'AskUserQuestion') {
          // The canUseTool bridge below renders this as a Codex-native
          // dynamicToolCall via onUserInputRequest. Skip the generic
          // tool_use event so the App doesn't also draw an mcpToolCall card
          // for the same question.
          continue
        }
        await pending.handlers.onEvent({ type: 'tool_use', toolUseId: id, toolName: name, input })
        if (isWorkflowTool(name)) pending.workflowToolUseIds.add(id)
      }
    }
  }

  private async handleUser(pending: PendingTurn, message: Record<string, unknown>): Promise<void> {
    // The SDK delivers tool_result blocks as a 'user' message turn from the
    // CLI's perspective. Surface them so the server can update the matching
    // tool item.
    const workflowLaunchResult =
      message.tool_use_result ?? (message as Record<string, unknown>).toolUseResult
    let workflowLaunchAttached = false
    const inner = message.message as Record<string, unknown> | undefined
    if (!inner) return
    const content = Array.isArray(inner.content)
      ? (inner.content as Array<Record<string, unknown>>)
      : []
    const toolResultCount = content.filter((block) => String(block.type) === 'tool_result').length
    for (const block of content) {
      if (String(block.type) !== 'tool_result') continue
      const toolUseId = String(block.tool_use_id ?? '')
      if (!toolUseId) continue
      const isWorkflowLaunch = pending.workflowToolUseIds?.delete(toolUseId) === true
      const wasSubagent = pending.activeSubagents.delete(toolUseId)
      // Even if this was a subagent we still emit its tool_result so the
      // server's subagent state machine closes the collabAgentToolCall.
      const isError = Boolean(block.is_error)
      const bodyContent = block.content
      await pending.handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: bodyContent,
        isError,
      })
      if (!workflowLaunchAttached && isWorkflowLaunch && toolResultCount === 1) {
        workflowLaunchAttached = true
        this.attachWorkflowJournal(pending, workflowLaunchResult, toolUseId)
      }
      void wasSubagent
    }
  }

  private attachWorkflowJournal(pending: PendingTurn, value: unknown, toolUseId: string): void {
    const launch = parseWorkflowLaunchInfo(
      value,
      pending.workflowTranscriptRoots ?? defaultWorkflowTranscriptRoots(process.env),
    )
    if (!launch) return
    if (pending.skippedWorkflowTaskIds?.has(launch.taskId)) return
    const state = pending.workflowTasks?.get(launch.taskId)
    if (!state) {
      const boundState = [...(pending.workflowTasks?.values() ?? [])].find(
        (candidate) => candidate.toolUseId === toolUseId,
      )
      if (boundState) return
      const launches = pending.workflowLaunches ?? (pending.workflowLaunches = new Map())
      launches.set(toolUseId, launch)
      return
    }
    this.attachParsedWorkflowJournal(pending, state, launch, toolUseId)
  }

  private attachParsedWorkflowJournal(
    pending: PendingTurn,
    state: WorkflowTaskState,
    launch: WorkflowLaunchInfo,
    toolUseId: string,
  ): void {
    if (launch.taskId !== state.taskId) return
    if (state.toolUseId && state.toolUseId !== toolUseId) return
    if (!state.toolUseId) state.toolUseId = toolUseId
    state.workflowName = launch.workflowName || state.workflowName
    state.description = launch.summary || state.description
    state.prompt = state.prompt || state.description || state.workflowName
    if (state.terminal || state.aggregateStarted || state.monitor) return

    state.monitor = this.createWorkflowMonitor(pending, state, launch)
    state.monitor.start()
  }

  private attachDeferredWorkflowJournal(
    pending: PendingTurn,
    state: WorkflowTaskState,
    sourceToolUseId: string,
  ): void {
    const launches = pending.workflowLaunches
    if (!launches || launches.size === 0) return
    if (sourceToolUseId) {
      const launch = launches.get(sourceToolUseId)
      if (!launch) return
      launches.delete(sourceToolUseId)
      this.attachParsedWorkflowJournal(pending, state, launch, sourceToolUseId)
      return
    }
    const matches = [...launches.entries()].filter(([, launch]) => launch.taskId === state.taskId)
    if (matches.length !== 1) return
    const match = matches[0]
    if (!match) return
    const [toolUseId, launch] = match
    launches.delete(toolUseId)
    this.attachParsedWorkflowJournal(pending, state, launch, toolUseId)
  }

  private discardDeferredWorkflowLaunches(
    pending: PendingTurn,
    taskId: string,
    sourceToolUseId: string,
  ): void {
    const launches = pending.workflowLaunches
    if (!launches) return
    if (sourceToolUseId) launches.delete(sourceToolUseId)
    for (const [toolUseId, launch] of launches) {
      if (launch.taskId === taskId) launches.delete(toolUseId)
    }
  }

  private createWorkflowMonitor(
    pending: PendingTurn,
    state: WorkflowTaskState,
    launch: WorkflowLaunchInfo,
  ): WorkflowJournalMonitor {
    return new WorkflowJournalMonitor({
      launch,
      onStarted: async (agent) => {
        if (state.terminal) return
        const toolUseId = workflowAgentToolUseId(state.taskId, agent.agentId)
        if (
          pending.activeSubagents.has(toolUseId) ||
          pending.completedWorkflowTasks.has(toolUseId)
        ) {
          return
        }
        pending.activeSubagents.add(toolUseId)
        try {
          await pending.handlers.onEvent({
            type: 'tool_use',
            toolUseId,
            toolName: 'Agent',
            input: {
              description: agent.description,
              prompt: agent.prompt,
              subagent_type: 'workflow',
            },
          })
        } catch (error) {
          pending.activeSubagents.delete(toolUseId)
          throw error
        }
      },
      onResult: async (agent) => {
        if (state.terminal) return
        const toolUseId = workflowAgentToolUseId(state.taskId, agent.agentId)
        if (!pending.activeSubagents.has(toolUseId)) return
        await pending.handlers.onEvent({
          type: 'tool_result',
          toolUseId,
          content: agent.content,
          isError: agent.isError,
        })
        pending.activeSubagents.delete(toolUseId)
        pending.completedWorkflowTasks.add(toolUseId)
      },
      onError: async (error) => {
        if (state.terminal) return
        // Monitoring failures are terminal for the projected workflow. Record
        // the failure now so a later successful SDK result cannot revive the
        // task or leave the parent waiting for a journal that is no longer
        // being observed.
        const message = `Workflow monitoring failed: ${error.message}`
        state.monitorFailed = true
        state.monitor = null
        state.terminal = true
        pending.workflowFailure ??= message
        await this.closeWorkflowAgentLifecycles(pending, state, message, true)
        await this.closeWorkflowAggregateLifecycle(pending, state, message, true)
        if (state.toolUseId) pending.workflowToolUseIds.delete(state.toolUseId)
        await pending.handlers.onEvent({
          type: 'notice',
          level: 'warning',
          message,
        })
        if (pending.deferredResult) {
          pending.completedWorkflowTasks.add(workflowTaskToolUseId(state.taskId))
          pending.deferredResult = {
            ...pending.deferredResult,
            success: false,
            resultText: pending.deferredResult.resultText ?? message,
          }
          await this.finishDeferredResult(pending, true)
        }
      },
    })
  }

  private workflowProjectedAgentIds(pending: PendingTurn, state: WorkflowTaskState): string[] {
    const agentIds = new Set(state.monitor?.activeAgentIds() ?? [])
    const prefix = `workflow-agent:${state.taskId}:`
    for (const toolUseId of pending.activeSubagents) {
      if (!toolUseId.startsWith(prefix)) continue
      const agentId = toolUseId.slice(prefix.length)
      if (agentId) agentIds.add(agentId)
    }
    return [...agentIds]
  }

  private async closeWorkflowAgentLifecycles(
    pending: PendingTurn,
    state: WorkflowTaskState,
    message: string,
    isError: boolean,
  ): Promise<number> {
    let closed = 0
    for (const agentId of this.workflowProjectedAgentIds(pending, state)) {
      const toolUseId = workflowAgentToolUseId(state.taskId, agentId)
      if (!pending.activeSubagents.delete(toolUseId)) continue
      pending.completedWorkflowTasks.add(toolUseId)
      await pending.handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `${message}\nagentId: ${agentId}`,
        isError,
      })
      closed += 1
    }
    return closed
  }

  private async closeWorkflowAggregateLifecycle(
    pending: PendingTurn,
    state: WorkflowTaskState,
    message: string,
    isError: boolean,
  ): Promise<boolean> {
    const toolUseId = workflowTaskToolUseId(state.taskId)
    if (!pending.activeSubagents.delete(toolUseId)) return false
    pending.completedWorkflowTasks.add(toolUseId)
    await pending.handlers.onEvent({
      type: 'tool_result',
      toolUseId,
      content: message,
      isError,
    })
    return true
  }

  private ensureWorkflowTask(pending: PendingTurn, taskId: string): WorkflowTaskState {
    const tasks = pending.workflowTasks ?? (pending.workflowTasks = new Map())
    const existing = tasks.get(taskId)
    if (existing) return existing
    const state: WorkflowTaskState = {
      taskId,
      toolUseId: '',
      workflowName: '',
      description: '',
      prompt: '',
      monitor: null,
      aggregateStarted: false,
      terminal: false,
    }
    tasks.set(taskId, state)
    return state
  }

  private async ensureWorkflowAggregateStarted(
    pending: PendingTurn,
    state: WorkflowTaskState,
  ): Promise<void> {
    if (state.terminal || state.aggregateStarted) return
    const toolUseId = workflowTaskToolUseId(state.taskId)
    if (pending.completedWorkflowTasks.has(toolUseId)) return
    state.aggregateStarted = true
    pending.activeSubagents.add(toolUseId)
    try {
      await pending.handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Agent',
        input: {
          description: state.workflowName ? `Workflow: ${state.workflowName}` : 'Workflow',
          prompt: state.prompt || state.description || state.workflowName || 'Workflow',
          subagent_type: 'workflow',
        },
      })
    } catch (error) {
      state.aggregateStarted = false
      pending.activeSubagents.delete(toolUseId)
      throw error
    }
  }

  private async stopWorkflowTasks(pending: PendingTurn): Promise<void> {
    const tasks = pending.workflowTasks
    if (tasks) {
      for (const state of tasks.values()) {
        state.terminal = true
        await state.monitor?.stop()
        await this.closeWorkflowAgentLifecycles(
          pending,
          state,
          'Workflow monitoring stopped before the agent published an individual result.',
          true,
        )
        await this.closeWorkflowAggregateLifecycle(
          pending,
          state,
          'Workflow monitoring stopped before the workflow published a terminal result.',
          true,
        )
      }
    }
    pending.workflowLaunches?.clear()
  }

  private hasPendingWorkflowTasks(pending: PendingTurn): boolean {
    if ((pending.workflowToolUseIds?.size ?? 0) > 0) return true
    if ((pending.workflowLaunches?.size ?? 0) > 0) return true
    for (const state of pending.workflowTasks?.values() ?? []) {
      if (!state.terminal) return true
    }
    return false
  }

  private async finishDeferredResult(pending: PendingTurn, force = false): Promise<void> {
    const deferred = pending.deferredResult
    if (!deferred || pending.resolved) return
    if (force && deferred.success && !pending.input.consumedBy(deferred.inputReceipt)) {
      deferred.success = false
      deferred.resultText = 'SDK 退出前未确认追加指令，执行结果不确定，请读取历史对账'
    }
    if (!force && deferred.success && !pending.input.consumedBy(deferred.inputReceipt)) return
    if (!force && deferred.success && this.hasPendingWorkflowTasks(pending)) return

    pending.deferredResult = null
    pending.resolved = true
    pending.input.close()
    this.turns.delete(pending.context.turnId)
    try {
      await pending.handlers.onEvent({
        type: 'completed',
        success: deferred.success,
        result: deferred.resultText,
        claudeSessionId: deferred.claudeSessionId,
      })
      if (deferred.success) {
        pending.resolve()
      } else {
        pending.reject(new Error(deferred.resultText ?? 'Claude turn failed'))
      }
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async handleResult(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (pending.resolved) return
    const subtype = String(message.subtype ?? '')
    const success = subtype === 'success' && !message.is_error && pending.workflowFailure == null
    const resultText =
      pending.workflowFailure ?? (message.result == null ? null : String(message.result))
    const claudeSessionId = message.session_id == null ? null : String(message.session_id)
    const usage = (message.usage as Record<string, unknown>) || {}
    // Push usage + metrics before completed so server can roll them into the
    // turn before emitting turn/completed.
    if (Object.keys(usage).length > 0) {
      await pending.handlers.onEvent({ type: 'usage', usage })
    }
    await pending.handlers.onEvent({
      type: 'metrics',
      durationMs: numberOrNull(message.duration_ms),
      apiDurationMs: numberOrNull(message.duration_api_ms),
      numTurns: numberOrNull(message.num_turns),
      costUsd: numberOrNull(message.total_cost_usd),
    })
    // If we suppressed text for StructuredOutput, emit the coerced JSON now.
    if (pending.context.outputFormat && pending.structuredBuffer) {
      await pending.handlers.onEvent({ type: 'text_delta', delta: pending.structuredBuffer.trim() })
    }
    pending.deferredResult = { success, resultText, claudeSessionId, inputReceipt: message }
    if (!success) await this.stopWorkflowTasks(pending)
    await this.finishDeferredResult(pending)
  }

  private async handleOther(
    pending: PendingTurn,
    type: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (type === 'rate_limit' || type === 'rate_limit_event') {
      const info = message.rate_limit_info as Record<string, unknown> | undefined
      // Subscription usage updates also arrive when requests are allowed.
      // Those are bookkeeping, not warnings about a failed model request.
      if (info?.status === 'allowed') return
      const explicit = stringOrNull(message.message)
      if (!explicit && info?.status !== 'allowed_warning' && info?.status !== 'rejected') {
        if (type === 'rate_limit_event') return
      }
      await pending.handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: explicit ?? rateLimitNotice(info),
      })
      return
    }
    if (type === 'hook' || type === 'hook_event' || type === 'system_hook_event') {
      const hookName = String(message.hook_event_name ?? message.hook_name ?? 'hook')
      const status = stringOrNull(message.status) ?? stringOrNull(message.subtype)
      const decision = stringOrNull(message.decision) ?? stringOrNull(message.permission_decision)
      const text = stringOrNull(message.message) ?? stringOrNull(message.reason)
      await pending.handlers.onEvent({
        type: 'hook',
        hookName,
        status,
        decision,
        message: text,
      })
    }
  }
}

function rateLimitNotice(info: Record<string, unknown> | undefined): string {
  const window = String(info?.rateLimitType ?? 'usage').replaceAll('_', ' ')
  const status =
    info?.status === 'allowed_warning'
      ? `Claude usage is nearing the ${window} limit`
      : `Claude ${window} limit reached`
  const utilization = typeof info?.utilization === 'number' ? info.utilization : null
  const used = utilization == null ? '' : ` (${Math.round(utilization * 100)}% used)`
  const resetsAt = typeof info?.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : null
  const reset =
    resetsAt && Number.isFinite(resetsAt.getTime()) ? ` Resets at ${resetsAt.toISOString()}.` : ''
  return `${status}${used}.${reset}`
}

// Codex's (approvalPolicy, sandbox, planMode) tri-state → Claude SDK
// permissionMode. This preserves the adapter's old sidecar mapping while using
// the native TS SDK runtime.
function derivePermissionMode(
  approvalPolicy: ApprovalPolicy | null,
  sandboxMode: string | null,
  planMode: boolean,
): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto' {
  // 会话选择是权限来源，环境变量不能覆盖客户端授权。
  if (planMode) return 'plan'
  if (sandboxMode === 'danger-full-access' && approvalPolicy === 'never') return 'default'
  if (approvalPolicy === 'never') return 'dontAsk'
  return 'default'
}

// Subagent tool detection — same allowlist as Python's is_subagent_tool and
// TS isSubagentToolName in server.mts.
function isSubagentTool(name: string): boolean {
  const n = name.trim().toLowerCase()
  return (
    n === 'task' || n === 'agent' || n === 'subagent' || n === 'spawn_agent' || n === 'spawnagent'
  )
}

function isWorkflowTool(name: string): boolean {
  return name === 'Workflow'
}

function isWorkflowBackgroundTask(message: Record<string, unknown>): boolean {
  return String(message.task_type ?? '') === 'local_workflow'
}

function workflowTaskToolUseId(taskId: string): string {
  return `workflow-task:${taskId}`
}

function workflowAgentToolUseId(taskId: string, agentId: string): string {
  return `workflow-agent:${taskId}:${agentId}`
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function workflowTaskUsage(value: unknown): {
  totalTokens: number
  toolUses: number
  durationMs: number
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  const totalTokens = numberOrNull(usage.total_tokens)
  const toolUses = numberOrNull(usage.tool_uses)
  const durationMs = numberOrNull(usage.duration_ms)
  if (totalTokens === null || toolUses === null || durationMs === null) return null
  return { totalTokens, toolUses, durationMs }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function sdkResumeSessionId(value: string | null, _cwd?: string): string | null {
  // 只恢复调用方明确指定的会话；交由 SDK 报告不存在或损坏的历史。
  return value
}

// ── AskUserQuestion bridging helpers ──

// Parse the Claude SDK AskUserQuestionInput envelope into Codex's per-question
// shape. Claude's input is `{questions: [{question, header, options:[{label,
// description, preview?}], multiSelect}]}`. Codex's wire format separates the
// "Other" / free-text path via the `isOther` flag — we synthesise an extra
// option per question to mirror the harness behaviour (AskUserQuestion always
// implicitly offers an Other choice).
export function parseAskUserQuestions(input: Record<string, unknown>): UserInputQuestion[] {
  const raw = (input.questions as Array<Record<string, unknown>>) || []
  const out: UserInputQuestion[] = []
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] || {}
    const header = String(q.header ?? `Question ${i + 1}`)
    const question = String(q.question ?? '')
    const optionsRaw = (q.options as Array<Record<string, unknown>>) || []
    const options = optionsRaw.map((o) => ({
      label: String(o.label ?? ''),
      description: String(o.description ?? ''),
    }))
    // Claude's harness implicitly offers an "Other" free-text choice; surface
    // it as a Codex isOther option so the App renders the free-text affordance.
    options.push({ label: 'Other', description: 'Provide a custom answer' })
    out.push({
      id: `q${i}`,
      header: header.slice(0, 12),
      question,
      isOther: false,
      isSecret: false,
      options,
    })
  }
  return out
}

// 转换为原生 AskUserQuestion 的 updatedInput。
export function formatAskUserQuestionAnswers(
  input: Record<string, unknown>,
  questions: UserInputQuestion[],
  answers: UserInputAnswers,
): string {
  const original = (input.questions as Array<Record<string, unknown>>) || []
  const answersByQuestion: Record<string, string> = {}
  const annotations: Record<string, { notes?: string; preview?: string }> = {}
  for (const [i, q] of questions.entries()) {
    const origQ = original[i] || {}
    const questionText = String(origQ.question ?? q.question)
    const slot = answers.answers[q.id]
    if (!slot) {
      answersByQuestion[questionText] = ''
      continue
    }
    const picked = Array.isArray(slot.answers) ? slot.answers.filter((s) => s !== 'Other') : []
    const notes = typeof slot.notes === 'string' ? slot.notes : null
    // Other-only: notes is the user's free-text reply.
    if (picked.length === 0 && notes) {
      answersByQuestion[questionText] = notes
    } else if (notes && picked.includes('Other')) {
      answersByQuestion[questionText] = notes
    } else {
      // Multi-select Claude format = comma-separated labels.
      answersByQuestion[questionText] = picked.join(', ')
    }
    if (notes) annotations[questionText] = { notes }
  }
  const payload = {
    questions: original,
    answers: answersByQuestion,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  }
  return JSON.stringify(payload)
}
