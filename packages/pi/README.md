# Pi 适配器

目标是通过 Codex 桌面与 Tyrs 客户端使用 Pi 原生引擎。适配器只负责客户端协议、展示与交互，不把 Pi 改造成 Codex。

## 固定组合

Node 24.14.0；Codex 协议 0.157.1；Pi SDK/CLI 0.99.1；
`@narumitw/pi-plan-mode` 0.58.3；`@narumitw/pi-tui-kit` 0.59.0；
`@gotgenes/pi-subagents` 21.8.1。依赖使用精确版本及独立锁文件。

从仓库根目录运行：

```sh
npm ci
npm ci --prefix packages/pi
npm --prefix packages/pi run build
npm --prefix packages/pi run test:version-gate
npm --prefix packages/pi test
```

真实 SDK 测试只使用回环 mock provider 和临时 agentDir，不读取生产模型凭据。

## Worker 配置

```sh
TYRS_HAND_WORKER_PI_ENABLED=true
TYRS_HAND_WORKER_PI_BIN=/usr/local/libexec/tyrs-hand-pi
TYRS_HAND_WORKER_PI_SSH_LISTEN_ADDR=:3334
```

Pi 默认关闭，可独立于 Claude 启用。三个引擎共用 Worker 身份、客户端授权和并发配额，分别使用进程、Hub、socket、适配元数据目录和 SSH HostKey。

`TYRS_HAND_WORKER_PI_BIN` 指向解包制品中的 `pi-runtime/bin/pi-codex`（可通过软链接提供上述路径）。宿主应已有 Pi CLI >= 0.99.1；`PI_CLI` 可指定其可执行文件。适配器不会安装或升级用户 CLI。`--runtime-info` 会校验 CLI 与 Node 不低于锁定版本。

Pi 配置沿用原生 agentDir，支持 `PI_CODING_AGENT_DIR`，保留 provider 和代理环境变量；Worker 内部凭据不传入引擎。`PI_ADAPTER_HOME` 只存放适配数据库，不放模型凭据和原生 JSONL。

Linux amd64 制品还需要宿主提供 Python 3（PTY bridge）、POSIX shell 和常规文件命令。构建入口为 Tyrs 仓库 `tools/package-pi-runtime.sh`，包含解包后的文件、监听、搜索、PTY 与 SDK mock 验收。

## 原生行为

- 模型上下文唯一来自 Pi JSONL 与会话树。适配库保存协议 ID、历史投影、提交幂等、项目/侧栏/附件和队列。
- CLI 与适配器可交替执行同一会话；不能同时写入。检测到外部并发修改时停止当前回合、暂停队列并要求重新加载。
- fork、回退与 compact 使用官方 SessionManager/AgentSession。回退保留历史分支，不撤销工作目录的文件修改。
- 原生名称就是标题；改名调用 `setSessionName()`，没有额外标题模型任务。
- 客户端权限档位不会增加审批或沙箱约束。原生扩展的标准问答仍转发。
- skills 和用户扩展沿用官方加载器；模型与技能开关通过官方设置接口写回。
- Plan 使用插件公开 `/plan start`、`/plan implement`、`/plan exit`；实施提交重试复用同一次执行。
- gotgenes 保留内置及全局代理，只投影委派、结果和状态。**不支持项目级代理定义**，不新增调度、worktree 或记忆系统。
- gotgenes 原生子会话按 JSONL 中的父会话 ID 投影为子代理线程，默认顶层列表不展示；支持按直接父线程或祖先查询。Pi 原生 fork 的文件路径来源不视为子代理关系。
- 推理内容投影到 Codex 推理摘要，流式通知与历史重放使用相同内容。原生菜单保留标签，选项没有额外说明时发送空描述。
- 管理的两个插件在同名注册冲突时优先；不修改用户插件或磁盘配置。

## 明确边界

不实现归档、Goal/预算续跑、专用 review、通用严格结构化输出，不安装搜索或生图插件。不支持的业务操作返回明确错误，不返回伪成功。Tyrs 为 Pi 隐藏归档入口，并提供空闲会话删除入口；删除会删除原始 JSONL。

模型侧 MCP 直接装配官方 CLI 的 `builtInExtensions` 清单，保留第三方替换规则和原生 `mcp.json` 配置。**用户已决策：首期不桥接 Codex MCP 管理面板**。面板状态、OAuth、资源直读和工具直调协议返回明确的不支持错误，不伪造空服务器列表，不新增管理器。这是范围边界，不再列作未完成的 P1。

TUI 专用自定义组件遵循 Pi RPC 的限制。标准 select、confirm、input、editor 转发到客户端问答。

## 验收边界

测试覆盖真实 SDK 与 mock provider、协议 schema、双 RPC 客户端互见、幂等、停止/队列、原生恢复、Plan、子代理、文件终端。Tyrs 的 `tools/pi-e2e.mjs` 使用真实 Control/PostgreSQL/Redis/Worker/SSH 3334；它是协议集成验收，不能替代桌面和移动端 UI 验收。

2026-10-01，独立验收任务使用真实 ChatGPT.app 完成桌面 9/9 场景（CHAT、TOOLS、STOP、THINK、WRITE、PLAN、STEER、MODEL、SUBAGENT），wire schema 错误为 0。移动端 UI 按用户决定本期暂不验收，记录为未覆盖项，不作为本期阻塞；MCP 管理面板属于已决策范围边界。

当前 `releaseReady` 保持 false：源码及桌面验收已通过，固定提交的最终 Linux 制品仍需在内部构建流水线中完成解包自检、SHA-256 与 Sigstore 签名核验。该值不表示桌面验收未通过，也不会阻止内部制品构建。生产安装由部署任务另行执行。
