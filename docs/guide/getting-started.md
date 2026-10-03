# 开始使用

完整安装命令、依赖版本及两个 harness 的连接步骤统一维护在[项目 README](https://github.com/slovx2/codex-harness-adapter#从源码启动)。

## 系统依赖

- macOS/Linux：Python 3、POSIX shell 和系统常用命令。Claude 在 Linux 上需要 bubblewrap、socat 和可用的用户命名空间；macOS 使用系统 sandbox-exec。
- Windows：Windows 10/11、Git for Windows；命令行 SSH 验证需要 OpenSSH Client。无需 WSL 或 Python，可用 `CLAUDE_CODE_GIT_BASH_PATH` 指定 `bash.exe`。
- Windows 上 Claude 命令执行需要显式选择“完全访问”；受限 Bash 会报错。需要操作系统沙箱时，在 WSL2 内按 Linux 方式运行。

安装后用 `node --version`、`go version`、`claude --version` / `pi --version` 自检。只需安装要使用的引擎；可用 `CHA_CLAUDE_CLI` / `PI_CLI` 指定其路径。模型登录和配置由原生引擎管理。

## 启动与连接

运行 `npm run setup` 安装并构建，再用 `npm start` 自动检测和启动可用引擎。缺失或启动失败的引擎只告警，不影响其他入口；没有可用入口时才整体失败。使用 `npm start -- --harness claude-code` 或 `npm start -- --harness pi` 可单独启动一个引擎。

源码构建后也可使用 `bin/codex-harness-adapter` 的 `start`、`init`、`ssh-config`、`serve` 和 `doctor` 子命令。
Windows 原生环境使用 `bin/codex-harness-adapter.exe`，需要 Git for Windows，终端采用 ConPTY。

Claude 默认使用 `127.0.0.1:7331`，Pi 默认使用 `127.0.0.1:7332`。可用 `npm start -- --claude-port 7441 --pi-port 7442` 更改端口，单引擎用 `--port`。保持前台服务运行，按[桌面端配置指南](/guide/gui)添加设备和项目。

不需要启动系统 sshd，不修改用户的全局 PATH，也不需要安装 Tyrs Hand。

这是一次破坏性版本整理。旧适配数据库和配置不自动迁移，原生会话文件不会被删除或批量改写。
