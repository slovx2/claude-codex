# 开始使用

完整安装命令、依赖版本及两个 harness 的连接步骤统一维护在[项目 README](https://github.com/slovx2/codex-harness-adapter#从源码构建)。

源码构建后使用 `bin/codex-harness-adapter` 的 `init`、`ssh-config`、`serve` 和 `doctor` 子命令。
Windows 原生环境使用 `bin/codex-harness-adapter.exe`，需要 Git for Windows，终端采用 ConPTY。

Claude 默认使用 `127.0.0.1:7331`，Pi 默认使用 `127.0.0.1:7332`。初始化专用身份后，将输出的 SSH 配置手动加入用户配置，并保持前台服务运行。

不需要启动系统 sshd，不修改用户的全局 PATH，也不需要安装 Tyrs Hand。

这是一次破坏性版本整理。旧适配数据库和配置不自动迁移，原生会话文件不会被删除或批量改写。
