# codex-harness-adapter

**在 Codex 桌面端连接各种 harness。**

把 Claude Code 或 Pi 接入 Codex 的 SSH 连接入口，在同一个桌面界面中使用不同的编码引擎。适配器运行在你的机器上，复用引擎自己的工具、会话和配置。

目前提供 Claude Code 和 Pi 两种适配器，支持 macOS、Linux 和 Windows 原生环境。项目处于开发阶段；客户端协议固定为 Codex app-server **0.157.1**，桌面端更新后需要重新验证连接行为。

## 工作方式

```text
Codex 桌面端
    ├─ SSH 127.0.0.1:7331 → Claude 适配器 → Claude Code
    └─ SSH 127.0.0.1:7332 → Pi 适配器     → Pi
```

每个入口拥有独立的进程、HostKey、socket、适配数据库和日志。SSH 会话中的 `codex` 命令由入口包装器提供，用户平时使用的 Codex CLI 和全局 PATH 不会被修改。

适配器负责把引擎事件、工具调用、审批和会话历史映射到 Codex 协议。模型执行和原生会话仍由各 harness 管理。

## 准备环境

源码构建使用以下固定版本：

| 组件 | 版本 |
| --- | --- |
| Node.js | 24.14.0 |
| Go | 1.26.6 |
| Claude Agent SDK | 0.3.282 |
| Claude Code CLI 基线 | 2.1.282 |
| Pi SDK / CLI 基线 | 0.99.1 |

依赖版本由 package.json、锁文件和 `protocol/versions.json` 记录。运行时对宿主 CLI 执行最低版本检查；不自动安装或升级用户的 CLI。

macOS/Linux 的终端功能需要 Python 3、POSIX shell 和系统常用命令。Claude 在 Linux 上还需要 bubblewrap、socat 和可用的用户命名空间；macOS 使用系统 sandbox-exec。缺少沙箱依赖会报错，不会静默改成无沙箱执行。

Windows 使用原生 ConPTY、命名管道和 Job Object，不依赖 WSL 或 Python。需要支持 ConPTY 的 Windows 10/11、Git for Windows，以及固定版本 Node、Go。SSH 登录 shell 使用 Git Bash；可通过 `CLAUDE_CODE_GIT_BASH_PATH` 指定 `bash.exe`。Windows CI 在 Windows Server 2025 x64 上验证。

**Windows 沙箱限制：** Claude 原生 Windows 环境不提供操作系统沙箱。选择“完全访问”后可执行命令；只读、工作区沙箱和计划模式中的受限 Bash 会明确报错，不会自动放宽权限。需要操作系统沙箱时，在 WSL2 内按 Linux 方式运行。文件工具仍遵守适配器的审批和路径检查。

先安装需要使用的官方 Claude Code 或 Pi CLI，并通过原生工具配置模型和登录。可用 `CHA_CLAUDE_CLI`、`PI_CLI` 指定 CLI 路径；原生 `CLAUDE_CONFIG_DIR`、`PI_CODING_AGENT_DIR` 等配置仍由对应引擎管理。

## 从源码构建

```sh
git clone https://github.com/slovx2/codex-harness-adapter.git
cd codex-harness-adapter
npm ci
npm ci --prefix packages/claude
npm ci --prefix packages/pi
npm run build
./bin/codex-harness-adapter doctor
```

Windows 在 PowerShell 中执行同样的 clone、npm 安装和构建命令，随后使用 `.exe`：

```powershell
.\bin\codex-harness-adapter.exe doctor
.\bin\codex-harness-adapter.exe init --harness claude-code
.\bin\codex-harness-adapter.exe ssh-config --harness claude-code
.\bin\codex-harness-adapter.exe serve --harness claude-code
```

Pi 将 `--harness` 改为 `pi`。默认状态位于 `%USERPROFILE%\.codex-harness-adapter`。
私钥目录会应用当前 Windows 用户的专用 ACL。测试连接需要启用 Windows 的 OpenSSH Client；
将配置添加到 `%USERPROFILE%\.ssh\config` 后，使用 `ssh codex-harness-adapter-claude 'codex --version'` 检查。
也可以在所有平台使用 `npm run doctor` 和 `npm start -- --harness pi`。

原生 Windows SSH/SDK 自动化验收不代表已经完成 Codex 桌面 GUI 验收；该项仍待实际客户端确认。

只检查某一个引擎：

```sh
./bin/codex-harness-adapter doctor --harness pi
```

`doctor` 检查运行时身份、版本和真实 PTY。模型认证是否可用需通过实际会话验证。

## 连接 Claude Code

```sh
./bin/codex-harness-adapter init --harness claude-code
./bin/codex-harness-adapter ssh-config --harness claude-code
./bin/codex-harness-adapter serve --harness claude-code
```

将 `ssh-config` 输出的完整片段手动加入 `~/.ssh/config`，保持 `serve` 在前台运行，然后在 Codex 桌面端的连接设置中选择 **codex-harness-adapter-claude** 并添加项目目录。

## 连接 Pi

在另一个终端运行：

```sh
./bin/codex-harness-adapter init --harness pi
./bin/codex-harness-adapter ssh-config --harness pi
./bin/codex-harness-adapter serve --harness pi
```

添加对应 SSH 配置后，在桌面端选择 **codex-harness-adapter-pi**。两个入口可同时运行。

默认端口分别是 7331、7332。需要更换端口时，对 `init`、`ssh-config` 和 `serve` 传入相同的 `--port`。所有入口固定绑定 `127.0.0.1`，仅接受专用公钥，不提供通用端口转发。

按 Ctrl-C 停止前台服务。服务会清理自己的运行进程和 socket，保留会话与日志。

## 状态与排障

默认状态位于 `~/.codex-harness-adapter/<harness>/`。`--home` 可以指定另一个状态根目录，`--node` 和 `--root` 分别指定 Node 路径和源码根目录。

- **找不到连接**：确认 SSH 配置已保存，并运行 `ssh codex-harness-adapter-pi 'codex --version'` 验证入口。
- **运行时启动失败**：运行 `doctor --harness <名称>`，查看对应状态目录的 `runtime.log`。
- **端口或目录被占用**：停止原服务，或为新实例选择不同的 `--home` 和 `--port`。
- **缺少模型或认证失败**：在原生 CLI 中检查配置和登录。

初始化会保留已有私钥与 HostKey。服务以当前用户身份访问本机文件，SSH 接入本身不是文件系统沙箱。

### 旧版本数据

这是一次破坏性整理。新版本不读取旧适配器配置名，不迁移旧适配数据库，也不解释原来的 `tyrs-*` 会话投影标记。显式传入旧数据库会报错。

旧数据库和 Claude/Pi 原生会话文件不会被自动删除或批量改写。原生会话仍可由原生工具使用，但不保证恢复旧适配器的展示元数据。

## 开发与集成

- `packages/claude`：Claude 协议与运行时适配。
- `packages/pi`：Pi 协议与运行时适配。
- `packages/shared`：协议、传输、文件、终端及适配元数据基础能力。
- `sshserver`：可供其他 Go 项目使用的 SSH 库，通过接口注入环境、授权和运行时。
- `cmd/codex-harness-adapter`：本地前台 CLI。
- `protocol`：固定协议契约与版本清单。

```sh
npm run typecheck
npm run check
npm test
```

本项目提供可独立消费的适配器和 SSH 库。Control、Worker 注册、Hub、多端同步、业务授权、Discord 和部署功能留在 Tyrs Hand；本项目不需要安装或运行 Tyrs Hand。Tyrs Hand 的依赖切换单独推进。

## 来源与许可

本项目基于 [fuergaosi233/claude-codex](https://github.com/fuergaosi233/claude-codex) 扩展，保留其提交历史与版权。通用 SSH 实现提取自 Tyrs Hand。

项目代码采用 [MIT](LICENSE)。第三方组件保留各自的许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Claude Agent SDK 和 Claude Code 不属于本项目的 MIT 授权范围，使用时适用 Anthropic 的条款。

这是独立社区项目，与 OpenAI、Anthropic 或 Pi 的维护者没有官方隶属关系。
