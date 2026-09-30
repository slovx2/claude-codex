# Codex App Remote Capability Matrix

Codex App connects to a remote host via the normal Codex Remote SSH app-server
flow, while agent turns are routed to Claude Code. Default runtime is the Claude
Agent SDK sidecar; runtime selection is pluggable. Status legend: **Supported**,
**Experimental**, **Stub**, **Unsupported**, **N/A**.

## Core

| Area | Status | Notes |
| --- | --- | --- |
| Remote transport | Supported | SSH starts `codex app-server --listen unix://` + `proxy`; the shim reports a Codex-compatible version/user agent. |
| Thread lifecycle | Supported | start/resume/fork/archive/list/read + turn listing, backed by SQLite + Claude session ids. |
| Normal chat | Supported | `turn/start` streams Claude text/reasoning into Codex agentMessage/reasoning items. |
| 原生消息队列 | Supported | `thread/queue/add/list/update/delete/reorder/start` 持久化输入、顺序与消息身份；已加载线程自动执行，成功后继续消费，中断或失败后暂停。重启只读不执行，显式 resume/start 才恢复。领取与回合账本同事务，已消费或删除的消息 ID 不得重新入队。 |
| Steering / interrupt | Supported | `turn/steer` and `turn/interrupt` route to the active Claude client. |
| Token usage | Supported | SDK ResultMessage usage → TokenUsageBreakdown, pushed as `thread/tokenUsage/updated` (cumulative + last turn). |

## Runtime selection

| Backend | Status | Notes |
| --- | --- | --- |
| Selection mechanism | Supported | `CLAUDE_CODEX_RUNTIME_TYPE` picks native `codex` passthrough (shim) or adapter runtimes. Switch with `claude-codex-mode` on the host and reconnect. |
| agent-sdk-sidecar (default) | Supported | In-process Claude Agent SDK; full tool/permission/reasoning events. |
| agent-http / Channels | Experimental | Consumes `POST /message`, `GET /messages|/status|/events`; message-level deltas only, no semantic tool/permission/reasoning events. |
| agentapi | Experimental | Same HTTP/SSE client against coder/agentapi; terminal-derived text only, no structured tool events. |
| claude-p | Experimental | `claude-p --output-format json --input-file ...` per turn; final transcript result only, not streaming, no `turn/steer`. |

## Models & turns

| Area | Status | Notes |
| --- | --- | --- |
| Model mapping | Supported | Native Claude aliases pass through; unknown Codex/OpenAI ids fall back to the default model. App model/effort selections are remembered and echoed via `config/read`. |
| Reasoning effort | Best effort | Codex efforts normalized, mappable via `CLAUDE_CODEX_EFFORT_ALIASES`; older SDKs may ignore unsupported options. |
| Structured title/summary turns | Supported (fallback) | Codex internal model ids (e.g. gpt-5.4-mini) map to `CLAUDE_CODEX_SUMMARY_MODEL` (default haiku) when an outputSchema is present; falls back to schema-shaped JSON if Claude emits plain text. |
| SDK option compatibility | Supported | When an older SDK rejects an option, the sidecar drops it one at a time (least essential first) and emits an info notice. |

## Tools, approvals & events

| Area | Status | Notes |
| --- | --- | --- |
| Claude Code tools | Supported | Not restricted by default; set `CLAUDE_CODEX_ALLOWED_TOOLS` to restrict. |
| Approval policy / sandbox | Supported | App's approvalPolicy + sandbox persist on the thread and map to Claude permission_mode. "Full access" drops the can_use_tool callback; read-only restricts tools to read/search. |
| Bash approval | Supported | can_use_tool → Codex `item/commandExecution/requestApproval`. Bypassed when approvalPolicy=never / Full access. |
| File edit approval | Supported | Edit/Write/MultiEdit → Codex fileChange items with approval + diff updates. |
| Bash output | Supported | Forwarded as command output on completion (SDK has no incremental tool-output streaming). |
| Generic Claude tools | Supported | Non-command/file tools → mcpToolCall items under the `claude-code` pseudo server. |
| Subagent (Task) | Supported | Task spawns an ephemeral child thread and emits native `subAgentActivity` lifecycle events (capability-gated `completed`) plus `spawnAgent`/`wait` tool state; inner events are hidden, and the final result lands as one agentMessage on the child thread. |
| Ephemeral / threadSource | Supported | `ephemeral: true` threads (title-gen, memory-consolidation, subagents) persist but are excluded from `thread/list` unless `includeEphemeral: true`. `threadSource` round-trips. |
| Claude side events | Supported | rate_limit / hook / subagent / compaction events summarized into structured notice lines. |
| Review mode | Supported (text) | `review/start` creates an in-progress review turn and routes the prompt through Claude. No native guardian finding items. |
| Context compaction | Supported (summary) | `thread/compact/start` routes the summary prompt and emits contextCompaction items. No native persisted rollout compaction. |

## Utilities

| Area | Status | Notes |
| --- | --- | --- |
| MCP config/status/tools | Supported | Reads Claude MCP config, passes servers into turns, calls stdio/HTTP tools directly. `mcpServerStatus/list` enumerates real `tools`/`resources`/`resourceTemplates` per server (10s cache, graceful empty fallback on spawn/timeout). |
| Turn-item paging | Supported | `thread/turns/list` honors `itemsView` — `summary` (default: first userMessage + final agentMessage), `full`, and `notLoaded` — instead of always shipping every item. |
| Skills & hooks | Supported | `skills/list` reads `.claude/skills/*/SKILL.md` (user+repo scope); `hooks/list` reads `settings.json` hooks, mapping Claude events to Codex `HookEventName` (unmappable events dropped). |
| Fuzzy file search | Supported | One-shot `fuzzyFileSearch` plus the stateful session API (`sessionStart/Update/Stop`) following Codex 0.157.1: one index per session, `sessionUpdated` then `sessionCompleted` per query, no completion on stop, at most 50 file or directory matches. |
| Git diff to remote | Supported | `gitDiffToRemote` diffs against the closest commit that also exists on a remote (Codex `git-utils` algorithm), including untracked files. |
| Background terminals | Supported | `thread/backgroundTerminals/list`, `terminate`, `clean` expose the live turn's background Bash tasks; they end with the per-turn Claude CLI. |
| Filesystem RPCs | Supported | `fs/readFile`, write, metadata, list, remove, copy, watch/unwatch (Codex v2-shaped). |
| Command/process RPCs | Supported | `command/exec` and `process/spawn` with PTY (`tty`) and piped modes, streaming stdin/stdout/stderr, resize, terminate/write. Semantics follow Codex 0.157.1: 10s default timeout (exit code 124 on timeout), immediate process-group SIGKILL, 1 MiB per-stream cap with `capReached` on the truncating chunk, 2s post-exit drain. PTY runs through `scripts/pty-bridge.py`, which the packaged runtime must ship. |
| 进程诊断 | Supported | `server/diagnostics` 返回当前适配器 PID、RSS 和实际活动回合/已初始化连接计数；physical footprint 无等价测量时返回 null。仅统计当前进程，不包含 CLI 子进程或 Worker 总占用；不会发起模型请求或返回配置、路径、凭据。 |

## Not applicable / unsupported

| Area | Status | Notes |
| --- | --- | --- |
| Realtime audio | Unsupported | No Claude audio channel; methods ack so capability probe doesn't error; listVoices returns empty. |
| Plugins/marketplace/apps | N/A | No Codex plugin marketplace; methods return empty schema-shaped responses. (Claude skills/hooks are surfaced — see Utilities.) |
| Account/rate limits/auth | N/A | Claude manages its own auth; account/OpenAI-auth panels report null/empty. |
| External agent import | Stub | `externalAgentConfig/detect` and import return empty. |
| Windows sandbox | Unsupported | Target deployment is Linux/macOS; methods return not configured. |

## Protocol version

The adapter advertises codex app-server protocol **v2 @ 0.142.3** (via
`codex --version` and the `initialize` userAgent; override with
`CLAUDE_CODEX_COMPAT_VERSION`). The 0.130 → 0.142 delta is additive and
backward-compatible: new optional request methods (`thread/search`,
`thread/delete`, `account/usage/read`, `plugin/*`, `remoteControl/*`,
`environment/add`, …) plus widened enums (`ReasoningEffort` → free-form string,
new `AuthMode` / `WebSearchMode` variants). The new methods are
OpenAI-account / plugin / remote-control surfaces with no Claude Code
equivalent; unimplemented methods return a JSON-RPC error, which Codex App
treats as "unsupported" for these optional features. Regenerate the reference
schema under `generated/` with `npm run generate:schema` (needs a matching
`codex` on PATH).

Because the adapter now reports the same version as a real `codex`, it appends a
distinguishing suffix: `codex --version` prints `codex-cli 0.142.3
(claude-codex)` and the `initialize` userAgent carries `claude-codex` in its
originator field. The version number stays first so the App's semver probe still
parses it. Set `CLAUDE_CODEX_VERSION_SUFFIX=""` to behave exactly like upstream
codex.

## Wire conformance

- `turn/start` response and the `turn/started` / `turn/completed` notifications
  ship `items: []` with `itemsView: "notLoaded"`, matching the real app-server
  (`bespoke_event_handling.rs` clears items; `turn_processor.rs` returns an empty
  turn). The timeline is driven by the `item/*` event stream; loaded items are
  only returned by history reads (`thread/read`, `thread/turns/list`).
- `thread/timeline/list` 从持久化历史返回普通回合边界及完整条目。最新页优先，
  页内升序，`nextCursor` 向更早历史推进；活动回合没有完成边界。
  0.157.1 的官方 TS/实际 wire 与 JSON Schema 对回合边界字段命名不一致，
  适配器同时提供同值的驼峰和下划线字段。普通会话的
  `activeRealtimeSessionAtPageStart` 为 `null`，不代表支持实时语音。
- `thread/revert` 按 `beforeTurnId` 删除目标回合及后续历史，通过真实 SDK 分叉
  保留原生上下文，SQLite 事务同时提交会话指针和展示历史。响应不内嵌回合，
  返回可包含最后保留条目的反向分页游标，并发布 `thread/reverted`。
  两种 `historyMode` 共用相同持久化数据，因此旧会话也可使用该入口；
  活动回合和其他线程的目标会被拒绝。回退不会撤销已有文件改动。
  SDK 分叉重新生成 UUID，适配器通过公开快照导出读取真实来源映射；
  回退时将保留回合的新边界与 session 指针一起事务提交，支持连续回退。
- The user message is recorded in turn history but, like the real app-server, is
  not surfaced as a `userMessage` `item/*` event during a turn (including
  `turn/steer`). `review/start`'s response carries the synthesized `userMessage`
  (itemsView `notLoaded`); `enteredReviewMode` arrives via `item/started`.
  Uploaded images are surfaced live as `imageView` `item/*` events.
- MCP boot status uses `mcpServer/startupStatus/updated` with a valid
  `McpServerStartupState`; `mcpServerStatus/list` returns conformant
  `McpServerStatus` objects (`{ name, tools, resources, resourceTemplates,
  authStatus }`).
- Lifecycle turn envelopes carry only schema fields — internal api/cost/turn
  metrics are not serialized onto the wire (token metrics flow through
  `thread/tokenUsage/updated`).
- `turn/plan/updated` is reserved for the `update_plan`/TodoWrite checklist tool
  and ships the spec shape `{ explanation, plan: [{ step, status }] }` (status
  ∈ pending/inProgress/completed); the checklist tool is not also surfaced as a
  timeline item. Plan-mode prose stays on the separate `plan` ThreadItem +
  `item/plan/delta` channel.

## Robustness notes

- `image.fileId` 保留在会话历史中。当前不能解析上游图片内容时，向模型明确传递不可读提示，
  正文及后续回合继续执行；纯文本提取（含 steer/恢复路径）使用同一提示。
  标识不能解释为本地路径或下载 URL。`native-image-reference.test.mts` 用真实 SDK/CLI
  验证提示实际进入模型请求以及重启保留原始附件；这是降级行为，图片下载能力仍未实现。
- `turn/settings/update` 通过 SDK 的 `applyFlagSettings` 实际更新当前回合的模型和 effort，
  不写用户配置或未来回合的线程设置；启动边界等待原生CLI就绪，错配或已结束目标返回
  `targetUnavailable`。TURNSETTINGS-001/002 验证实际模型HTTP参数、其他会话隔离和重启后的默认值。
  按用户的主流程兼容要求，附带的 `summary`、`serviceTier` 偏好在Claude没有对应语义时忽略，
  不阻断有效模型切换；`auto_review` / `guardian_subagent` 降级为用户审批，
  TURNSETTINGS-004验证真实文件写入仍等待人工回答且允许/拒绝均生效。
  非法模型/effort、协议外字段或非法审批角色仍拒绝，整批参数校验后才发布。
- 项目 CRUD、导入、重排与线程归属保存到 SQLite，创建和导入使用唯一幂等键。
  导入失败整体回滚；项目删除只解除归属，保留会话历史和源文件。
  `project/list` 支持位置与最近活动时间双向分页，空项目始终排在最后；
  `thread/list` 支持按项目或未归属筛选，游标绑定查询范围。
  fork 继承项目，临时会话归属不跨进程保存；归档会话不计入项目最近活动时间。
  PROJECT-002/003 使用真实 SDK/CLI 回合、重启及 SQLite 写入失败验证这些语义，
  并验证 `project/changed` 与 `thread/project/updated` 真实通知。
- 附件元数据由 `thread/attachment/add|list|remove` 真实持久化到 SQLite，
  `(threadId, attachmentType, identityKey)` 唯一；重复添加返回原内容，不覆盖 payload。
  仅创建和实际删除推送 `thread/attachment/updated`，分页游标绑定所属会话。
  ATTACHMENT-002 用真实 SDK/CLI 回合验证重启、跨线程及类型隔离、删除边界后继续分页、
  历史和源文件不变、删除会话清理附件；此能力不提供图片上传或 fileId 下载。
- Unix socket paths are validated against the platform `sun_path` limit (~104
  macOS / ~108 Linux); a deep `CODEX_HOME` falls back to a short hashed path
  under the system temp dir.
- git diff / file-listing failures are written to the debug log (distinguishing
  "not a git repository" from real errors) rather than swallowed.
- Per-thread in-memory state (command approvals, elicitation counts)
  is released when a thread is archived.
- 用量快照持久化在 SQLite。恢复会话推送已保存的累计用量，归档不清零，fork 复制后独立累计。
  EVENTS-002 通过真实 SDK 验证多块文本、事件顺序、历史与用量在重启后的一致性。
- 目标记录保存在 SQLite，归档和重启后仍保留；fork 复制独立快照，删除会话同时删除目标。
  部分更新保留未提供字段，显式 null 清除 tokenBudget。GOAL-001/003 验证这些存储语义。
  自动续跑、累计用量及预算停止尚待 GOAL-002 验收，当前不能宣称目标执行功能完整。

## Next targets

1. Parse Claude review text into first-class Codex review finding items.
2. Persist compaction summaries in a dedicated store, not just UI items.
3. Run the capability probe over SSH against a named host.
4. Flesh out plugin/skill/app surfaces if Codex App starts relying on them.
