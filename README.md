# codex-harness-adapter

**简体中文** | [English](README.en.md)

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

本机工具只要求满足以下最低稳定版本，**可以使用更高版本，无需降级或安装精确版本**：

| 本机工具 | 最低版本 |
| --- | --- |
| Node.js | 24.14.0 |
| Go | 1.26.6 |
| Claude Code CLI | 2.1.282 |
| Pi CLI | 0.99.1 |

Go 仅在源码构建时需要。运行时接受等于或高于最低版本的稳定版，拒绝低版本和预发布版；不自动安装或升级本机 CLI。只使用一个引擎时，只需安装该引擎的 CLI。

仓库的 SDK、插件等依赖仍由 `npm run setup` 按锁文件自动安装，无需用户逐项安装。Claude Agent SDK 0.3.282、Pi SDK 0.99.1 是当前可复现构建基线；完整组合见 `protocol/versions.json`。依赖锁和 CI 的精确版本用于开发验证，不是对用户本机工具的精确版本限制，也不同于 Codex 协议版本。

macOS/Linux 的终端功能需要 Python 3、POSIX shell 和系统常用命令。Claude 在 Linux 上还需要 bubblewrap、socat 和可用的用户命名空间；macOS 使用系统 sandbox-exec。缺少沙箱依赖会报错，不会静默改成无沙箱执行。

Windows 使用原生 ConPTY、命名管道和 Job Object，不依赖 WSL 或 Python。需要支持 ConPTY 的 Windows 10/11、Git for Windows，以及满足上述最低版本的 Node、Go。SSH 登录 shell 使用 Git Bash；可通过 `CLAUDE_CODE_GIT_BASH_PATH` 指定 `bash.exe`。Windows CI 在 Windows Server 2025 x64 上验证。

**Windows 沙箱限制：** Claude 原生 Windows 环境不提供操作系统沙箱。选择“完全访问”后可执行命令；只读、工作区沙箱和计划模式中的受限 Bash 会明确报错，不会自动放宽权限。需要操作系统沙箱时，在 WSL2 内按 Linux 方式运行。文件工具仍遵守适配器的审批和路径检查。

先安装需要使用的官方 Claude Code 或 Pi CLI，并通过原生工具配置模型和登录。可用 `CHA_CLAUDE_CLI`、`PI_CLI` 指定 CLI 路径；原生 `CLAUDE_CONFIG_DIR`、`PI_CODING_AGENT_DIR` 等配置仍由对应引擎管理。

安装入口：[Claude Code 官方安装说明](https://code.claude.com/docs/en/setup)、[Pi 官方安装说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#getting-started)。构建前可运行 `node --version`、`npm --version`、`go version`，以及所用引擎的 `claude --version` 或 `pi --version`。若提示找不到命令，安装后重新打开终端并确认命令已在 PATH 中。

## 从源码构建

```sh
git clone https://github.com/slovx2/codex-harness-adapter.git
cd codex-harness-adapter
npm run setup
npm start
```

以上命令适用于 macOS、Linux 和 Windows PowerShell。`setup` 安装仓库依赖并构建；以后每次使用只需在仓库目录运行：

```sh
npm start
```

这条命令自动检测 Claude Code 和 Pi 的 CLI、版本与运行环境，为可用引擎初始化密钥和状态目录并启动，无需分别执行 `init` 和 `serve`。重复启动保留已有密钥。日志逐项显示“正在检测”“检测通过”“SSH 就绪”；缺少 CLI 或启动失败的入口会告警，**不影响其他入口继续使用**。没有任何入口可用时才整体报错退出。

看到所需入口“SSH 就绪”后，保持此终端运行；按 Ctrl-C 同时停止本次启动的全部入口。

只装了一个 CLI，或只想启动一个引擎：

```sh
npm start -- --harness claude-code
# 或
npm start -- --harness pi
```

## 首次连接 Codex 桌面端

保持 `npm start` 运行，再按下面三步连接：

1. **可选：配置 SSH 别名。** 将启动时输出的完整 `Host` 配置段加入 `~/.ssh/config`（Windows 为 `%USERPROFILE%\.ssh\config`）。可以把 `Host` 后的名称改成易识别的别名，如 `claude-local`、`pi-local`；其他字段保持启动输出的值。没有目录或文件时创建即可。
2. **添加设备。** 打开 Codex 桌面端 → **设置 → 连接 → SSH → 添加**。选择刚配置的别名，或选择 **手动添加**。手动添加时按启动输出填写：主机 `127.0.0.1`、对应端口、用户 `local`、`IdentityFile` 指向的专用私钥；主机指纹应与启动日志一致。
3. **添加项目。** 回到主界面，点击 **添加项目** → 展开 **远程设备** 下拉菜单 → 选择刚添加的设备 → 选择项目目录并添加。虽然设备在本机，也要从这个 SSH 设备入口添加项目，才能使用对应引擎。

只启动一个引擎时，只添加对应设备。修改 SSH 端口后，设备连接参数也要同步更新。更多连接背景见 [OpenAI 官方连接说明](https://learn.chatgpt.com/docs/remote-connections)。

可选：配置别名后，在另一个终端验证入口（改过别名时使用自己的名称）：

```sh
ssh codex-harness-adapter-claude 'codex --version'
ssh codex-harness-adapter-pi 'codex --version'
```

Windows 需要启用 OpenSSH Client 来运行上述 `ssh` 命令；私钥目录会应用当前 Windows 用户的专用 ACL。原生 Windows SSH/SDK 自动化验收不代表已经完成 Codex 桌面 GUI 验收；该项仍待实际客户端确认。

需要重新查看 SSH 配置或检查环境：

```sh
npm run ssh-config -- --harness claude-code
npm run doctor -- --harness claude-code
# 检查所有引擎
npm run doctor
```

将 `claude-code` 换成 `pi` 可查看或检查 Pi；只装一个引擎时建议指定 `--harness`。`doctor` 检查运行时身份、版本和真实 PTY；不指定引擎会检查两者，任一缺失或失败都会返回非零退出码，不代表已启动的另一入口不可用。模型认证是否可用需通过实际会话验证。

以最后的“检查通过”和退出码判断本机环境诊断结果。详细信息中的 `releaseReady: false` 是项目尚未宣称完整发布验收的标记；Node 的 SQLite 实验性提示本身也不代表检查失败。

## 端口与高级启动

默认端口是 Claude 7331、Pi 7332。修改全部入口的端口：

```sh
npm start -- --claude-port 7441 --pi-port 7442
```

单入口可用 `npm start -- --harness pi --port 7442`。修改端口或状态根目录后，按新的启动输出更新 SSH 配置。所有入口固定绑定 `127.0.0.1`，仅接受专用公钥，不提供通用端口转发。

端口选项每次启动都需要传入；重新输出配置时也使用相同选项，例如 `npm run ssh-config -- --harness pi --port 7442`。若使用了 `--home`，查看配置和运行诊断时也传入同一目录。

也可直接运行 `./bin/codex-harness-adapter start`（Windows 为 `.\bin\codex-harness-adapter.exe start`）。需要手动控制初始化时，仍提供 `init`、`ssh-config`、`serve --harness <名称>`；`init` 不传 `--harness` 时初始化全部入口，`ssh-config` 默认输出已初始化的入口，跳过缺失入口并告警。

按 Ctrl-C 停止前台服务。服务会清理自己的运行进程和 socket，保留会话与日志。

## 状态与排障

默认状态位于 `~/.codex-harness-adapter/<harness>/`。`--home` 可以指定另一个状态根目录，`--node` 和 `--root` 分别指定 Node 路径和源码根目录。

- **找不到连接**：确认 SSH 配置已保存，并运行 `ssh codex-harness-adapter-pi 'codex --version'` 验证入口。
- **运行时启动失败**：运行 `npm run doctor -- --harness claude-code`（或 `pi`），查看对应状态目录的 `runtime.log`。
- **端口或目录被占用**：停止原服务，或为新实例选择不同的 `--home`，并用 `--claude-port` / `--pi-port`（单引擎用 `--port`）更改端口。
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
