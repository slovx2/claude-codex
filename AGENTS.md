# 开发约定

本项目将 Claude Code、Pi 等 harness 接入 Codex app-server 协议。

- 用中文写新增注释与维护文档。在当前分支工作，不创建 worktree。
- `packages/claude`、`packages/pi` 是并列适配器；`packages/shared` 只承载共享能力。
- `sshserver` 是通用 Go 库，不允许依赖 Tyrs Hand。`cmd/codex-harness-adapter` 是仅监听本机的 CLI。
- TypeScript 使用 `.mts`、ESM、可擦除语法；不手工修改 `dist` 或生成的协议材料。
- 依赖必须使用精确版本，版本组合见 `protocol/versions.json`。
- 旧适配数据库直接拒绝，不增加旧环境变量、持久化标记或路径回退。
- 修改应分小块进行，每次尽量不超过 300 行。

## 构建和检查

使用 Node 24.14.0、Go 1.26.6。

```sh
npm ci
npm ci --prefix packages/claude
npm ci --prefix packages/pi
npm run build
npm run check:fix
npm run typecheck
npm test
```

真实 Claude SDK 测试需通过 `CHA_CLAUDE_CLI` 指定隔离的官方 CLI。
测试不得继承个人模型凭据；使用回环 mock provider。
`npm run test:local-ssh` 验证真实 SSH 与 SDK，但不代表真实桌面 UI 验收。

包内约定见各自 `src/AGENTS.md`、`test/AGENTS.md`，脚本约定见 `scripts/AGENTS.md`。
