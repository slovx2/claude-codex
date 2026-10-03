# 开发约定

本项目将 Claude Code、Pi 等 harness 接入 Codex app-server 协议。

- 用中文写新增注释与维护文档。在当前分支工作，不创建 worktree。
- `packages/claude`、`packages/pi` 是并列适配器；`packages/shared` 只承载共享能力。
- `sshserver` 是通用 Go 库，不允许依赖 Tyrs Hand。`cmd/codex-harness-adapter` 是仅监听本机的 CLI。
- TypeScript 使用 `.mts`、ESM、可擦除语法；不手工修改 `dist` 或生成的协议材料。
- 仓库的依赖声明与锁文件必须使用精确版本，CI 的可复现验证基线见 `protocol/versions.json`；不要因此要求用户把本机工具降级或安装精确版本。
- 用户环境采用最低稳定版要求：Node.js >= 24.14.0、Go >= 1.26.6（仅源码构建）、Claude Code CLI >= 2.1.282、Pi CLI >= 0.99.1。版本检测接受基线及更高稳定版，拒绝低版本、预发布及非法格式；`engines` 是环境范围，不是依赖锁。
- README 中区分用户环境下限、仓库自动安装的 SDK/插件版本和 Codex 协议版本。不得把 CI 精确版本写成用户必须安装的版本。
- 默认用户入口是 `npm start`：自动检测 Claude/Pi 的 CLI 和运行环境，初始化并启动可用入口，逐项输出状态；缺失或失败只告警，不影响其他入口。支持 `--harness` 单独选择，没有入口可用才整体失败；中断时清理本次启动的全部进程。
- 旧适配数据库直接拒绝，不增加旧环境变量、持久化标记或路径回退。
- 修改应分小块进行，每次尽量不超过 300 行。

## 构建和检查

CI 使用 Node 24.14.0、Go 1.26.6 复现基线；本地可使用满足最低版本要求的更高稳定版。

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
