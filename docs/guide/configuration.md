# Configuration

All configuration is environment-driven (`CHA_CLAUDE_*`). Set these in the
remote login shell (e.g. `~/.zshenv`) or in `~/.codex-harness-adapter/runtime.env`.

## Runtime backend

```bash
# Default uses the in-process Claude Agent SDK.
export CHA_CLAUDE_RUNTIME_TYPE="agent-sdk-sidecar"
#   codex      - pass app-server through to the real Codex CLI (shim layer)
#   agent-http - HTTP/SSE bridge for Claude Code Channels / agent-http
#   agentapi   - HTTP/SSE bridge for coder/agentapi
#   claude-p   - one-shot PTY/transcript wrapper via claude-p
#   mock       - local protocol testing
```

See [Backends](/guide/backends) for what each route supports.

## Provider and agent-loop selection

Provider selection is descriptor metadata plus routing to existing runtime
backends. It does not add a new provider runtime, auth flow, subscription model,
gateway, or entitlement.

```bash
# Known provider descriptor ids.
export CHA_CLAUDE_PROVIDER="claude-code" # or "codex"

# Known agent-loop ids.
export CHA_CLAUDE_AGENT_LOOP="native-claude-code-sdk" # or "codex-jsonl-proxy"
```

Current mappings:

| Provider / loop | Existing runtime behavior |
| --- | --- |
| `claude-code` / `native-claude-code-sdk` | `agent-sdk-sidecar` |
| `codex` / `codex-jsonl-proxy` | `codex-proxy` |

Backward compatibility rules:

- `CHA_CLAUDE_RUNTIME_TYPE`, `CHA_CLAUDE_RUNTIME`, and
  `CHA_CLAUDE_BACKEND` still override provider selection when set.
- `CHA_CLAUDE_MOCK=1` still forces the `mock` runtime.
- Saved config can set `provider_loop_provider` and
  `provider_loop_agent_loop` through `config/value/write`.
- Raw saved selection keys are filtered out of public `config/read`; the safe
  projection appears under `config.provider_loop_config.selection`, with
  redacted validation issues when a selection is unknown or mismatched.

Selection must stay within supported credential ownership models. It does not
collect or share credentials, pool personal subscriptions, reuse browser cookies
or session tokens, configure private endpoints, or bypass provider terms.

## Models & effort

```bash
# Defaults for new threads, surfaced through config/read.
export CHA_CLAUDE_DEFAULT_MODEL="sonnet"
export CHA_CLAUDE_DEFAULT_EFFORT="medium"

# Codex App model picker list (comma-separated ids or JSON array of ids/objects).
export CHA_CLAUDE_MODELS="sonnet,opus,fable,haiku,sonnet-1m,opus-plan"

# Map Codex UI ids -> Claude SDK aliases/full names, and effort values.
export CHA_CLAUDE_MODEL_ALIASES='{"my-long-context":"sonnet[1m]"}'
export CHA_CLAUDE_EFFORT_ALIASES='{"xhigh":"max"}'
```

## MCP, tools & directories

```bash
# Passed to ClaudeAgentOptions (JSON object or path to a JSON file).
export CHA_CLAUDE_MCP_SERVERS='{"github":{"type":"stdio","command":"github-mcp"}}'

# Pre-approved tools (others still route through Codex approval) + extra dirs.
export CHA_CLAUDE_ALLOWED_TOOLS="Read,Glob,Grep"
export CHA_CLAUDE_ADD_DIRS="/repo/shared,/repo/docs"
export CHA_CLAUDE_ENABLE_FILE_CHECKPOINTING=1
```

## Worktree isolation

```bash
# Per-thread git worktree isolation (off by default — it creates branches).
export CHA_CLAUDE_AUTO_WORKTREE=1
export CHA_CLAUDE_WORKTREE_ROOT="$HOME/.codex-harness-adapter/worktrees"
```

When enabled, each new Codex thread runs in a dedicated `git worktree`.

## Daemon

```bash
# Idle shutdown grace period in ms (default 15000; 0 = never exit).
export CHA_CLAUDE_IDLE_EXIT_MS="15000"

# Pin a node binary for the shim (e.g. when default node is < 24).
export CHA_CLAUDE_NODE="/absolute/path/to/node"
```

## Reference table

| Setting | Purpose |
| --- | --- |
| `CHA_CLAUDE_ADAPTER` | Path to `packages/claude/dist/claude/src/adapter.mjs` (used by the shim). |
| `CHA_CLAUDE_NODE` | Node binary the shim launches. |
| `CHA_CLAUDE_COMPAT_VERSION` | Codex app-server version advertised (default `0.142.3`). |
| `CHA_CLAUDE_VERSION_SUFFIX` | Tag after the version to distinguish the adapter from real codex (default `codex-harness-adapter`; set `""` to behave exactly like upstream codex). |
| `CODEX_REAL` | Real Codex CLI for non-app-server commands / `codex` passthrough. |
| `CHA_CLAUDE_CLI` | 宿主 Claude Code 可执行文件，默认从 PATH 查找 claude；Worker 从 TYRS_HAND_WORKER_CLAUDE_CLI 注入。运行时诊断要求 CLI >= 2.1.282，配置仍由独立 CLAUDE_CONFIG_DIR 提供。 |
| `CHA_CLAUDE_RUNTIME_TYPE` | Active backend route. |
| `CHA_CLAUDE_PROVIDER` | Provider descriptor id (`claude-code` or `codex`) mapped only to existing runtime behavior. |
| `CHA_CLAUDE_AGENT_LOOP` | Agent-loop id (`native-claude-code-sdk` or `codex-jsonl-proxy`) mapped only to existing runtime behavior. |
| `provider_loop_provider` | Saved config key for provider descriptor selection via `config/value/write`. |
| `provider_loop_agent_loop` | Saved config key for agent-loop selection via `config/value/write`. |
| `CHA_CLAUDE_DEFAULT_MODEL` / `_EFFORT` | Defaults for new threads. |
| `CHA_CLAUDE_MODELS` | Codex App model picker list. |
| `CHA_CLAUDE_MODEL_ALIASES` / `_EFFORT_ALIASES` | Id remapping. |
| `CHA_CLAUDE_MCP_SERVERS` | MCP server config (JSON or file path). |
| `CHA_CLAUDE_ALLOWED_TOOLS` | Pre-approved tools. |
| `CHA_CLAUDE_ADD_DIRS` | Extra directories exposed to Claude. |
| `CHA_CLAUDE_ENABLE_FILE_CHECKPOINTING` | Enable SDK file checkpointing. |
| `CHA_CLAUDE_AUTO_WORKTREE` / `_WORKTREE_ROOT` | Per-thread worktree isolation. |
| `CHA_CLAUDE_IDLE_EXIT_MS` | Daemon idle shutdown. |
| `CHA_CLAUDE_MOCK` | Run the protocol without Claude credentials. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Claude auth / custom endpoint configuration. Keep real values out of git. |
