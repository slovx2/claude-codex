# Tyrs Hand 适配器实施状态

本 fork 从 `fuergaosi233/claude-codex@9fbf9137c642b2c14210cbf8b5f1eeab97f11051` 开始，保留上游历史及 MIT 许可。

当前为开发基线，`runtime/info.releaseReady=false`。尚未完成 Tyrs Hand 的全部协议和跨端验收，不应作为生产 Claude 入口发布。

## 固定版本与启动

- Node `24.14.0`
- Claude Agent SDK `0.3.282`，使用其随包 CLI，不接受宿主 Claude 替换。
- Codex 协议及测试 CLI `0.147.0`
- `scripts/worker-runtime` 是 Worker 专用启动入口，`--runtime-info` 返回实际 Node、SDK、CLI 构建及 CLI SHA256。
- Worker 必须提供独立 HOME、CLAUDE_CONFIG_DIR、CLAUDE_CODEX_HOME 和凭据环境；项目目录可以共享。
- Linux 运行时必须安装可执行的 `bwrap` 和 `socat`，macOS 必须有 `/usr/bin/sandbox-exec`。启动探测发现缺失会明确失败；实际沙箱初始化失败时 SDK 仍拒绝执行，不降级权限。

```sh
npm ci
npm run build
scripts/worker-runtime --runtime-info
npm test
npm run test:protocol
```

协议测试优先读取相邻主仓库固定 schema；独立 clone 可用 `CODEX_SCHEMA_DIR` 指定，或设置 `CODEX_TEST_BIN` 为精确 `0.147.0` CLI 自动生成。

## 已验证的实现

- SQLite 保存提交 ID、原生消息边界及工具执行意图。重试同一提交不创建第二个 Turn；未知工具结果禁止自动重放。
- 显式 session 恢复、原生 fork、rollback、原生 `/compact`。rollback 原生指针与展示历史在同一数据库事务提交；不回退工作区文件。
- 历史分页、客户端消息 ID 回显、活动 Turn 排他。
- 动态工具保存执行器原始结果与名称空间，避免 SDK 的模型上下文截断覆盖 UI 历史；大输出在重启后仍可完整读取，各历史视图与双向分页均有真实 SDK 用例。
- dynamicTools 通过真实 SDK MCP 桥接到 `item/tool/call`，测试检查实际文件副作用和下一轮 tool_result。
- HTTP MCP 的 Worker 配置字段翻译、环境变量引用、headers、同目录线程配置隔离。
- 项目 CLAUDE.md 与独立 Claude 配置目录中的 Skill 正文进入真实模型上下文。
- 未显式选模型时使用 `claude-default`，由 SDK 读取原生 `settings.json`；模型列表及标题请求也保留这一选择，避免内置 Sonnet 覆盖用户配置。
- 用户提问回调；回答限定于原始连接；重复回答、断线、取消、超时使旧请求失效。
- Plan/只读对文件写入的实际拒绝；401、429、500、503、SSE 半断均终结失败，关闭 CLI 自动重试。
- OpenAI 登录、额度、插件市场等明确拒绝，不转发到 Codex。

## 自动化证据与限制

`npm run test:protocol` 运行真实适配器、SDK 和 CLI，仅模型 HTTP 使用本地 Mock。临时 HOME、虚拟密钥、操作系统网络隔离确保不会读取个人模型登录态或访问公网模型。macOS 需要 sandbox-exec；Linux 需要可用的 user/network namespace、unshare 和 ip，缺失直接失败。

`.artifacts/protocol/` 输出本轮 run ID、JUnit、执行记录、脱敏 wire、模型请求和构建版本。schema 校验来自真实 CLI 生成的请求、通知及回调定义；缺失 schema 不静默放行。

尚需补齐：完整审批/权限矩阵、所有业务工具、stdio MCP/资源/elicitation/重载、所有文件与进程接口、更多事件/故障路径、所有扩展协议及受控桌面/手机 GUI 验收。当前 SDK 的 MCP 启动超时只有进程级配置，不同服务器设置不同启动超时会被明确拒绝。

主仓库维护完整清单和发布门禁；这里通过的子集不能代表整体方案完成。
