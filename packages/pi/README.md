# Pi 适配器

将 Pi 原生会话、工具与事件映射到 Codex app-server 协议。安装和本地 SSH 接入见[项目 README](../../README.md)。

原生模型上下文保存在 Pi JSONL 与会话树中；适配器数据库仅保存协议投影、提交幂等和界面元数据。

`CHA_PI_HOME` 指定适配器状态目录；`PI_CODING_AGENT_DIR` 和 `PI_CLI` 分别沿用原生配置目录与 CLI 路径。新写入的自定义条目使用 `codex-harness-adapter-*` 前缀，不处理旧 `tyrs-*` 标记。

CLI 与适配器可交替操作原生会话，但不能同时写入；检测到外部并发修改时停止当前回合，要求重新加载。

版本基线见 `protocol/versions.json`。真实 SDK 测试使用回环 mock provider 和临时配置目录，不读取个人模型凭据。
