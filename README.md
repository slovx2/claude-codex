# codex-harness-adapter

**简体中文** | [English](README.en.md)

## 解决什么问题

**用成熟的 Codex 桌面 UI 控制 Claude Code、Pi 等 harness。** 在一个界面里管理项目、对话、文件修改和审批，继续使用各引擎自己的模型配置与登录。

目前支持 Claude Code、Pi，适用于 macOS、Linux、Windows。

## 从源码启动

准备 Node.js **≥ 24.14.0**、Go **≥ 1.26.6**，以及至少一个已配置登录的引擎：[Claude Code **≥ 2.1.282**](https://code.claude.com/docs/en/setup) 或 [Pi **≥ 0.99.1**](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#getting-started)。接受更高稳定版本，无需安装精确版本。[各系统依赖](docs/guide/getting-started.md#系统依赖)

```sh
git clone https://github.com/slovx2/codex-harness-adapter.git
cd codex-harness-adapter
npm run setup
npm start
```

自动检测并启动可用引擎；缺失或失败只告警，不影响其他入口。看到“SSH 就绪”后保持终端运行，Ctrl-C 停止。以后启动只需 `npm start`。

## Codex 桌面配置

1. **可选：设置别名。** 将启动输出的 `Host` 配置加入 `~/.ssh/config`（Windows：`%USERPROFILE%\.ssh\config`），可自行修改别名。
2. **添加连接。** Codex **设置 → 连接 → SSH → 添加**，选择别名或 **手动添加**。手动填写启动输出中的主机、端口、用户和私钥路径。
3. **添加项目。** 主界面 **添加项目 → 远程设备下拉菜单 → 刚添加的设备 → 选择项目目录**。

即使项目在本机，也要从该 SSH 设备入口添加。[详细连接指南](docs/guide/gui.md)

## 工作原理、高级使用与排障

```text
Codex 桌面 → 本地 SSH → 适配器 → Claude Code / Pi
```

SSH 仅监听 `127.0.0.1`：Claude 默认 **7331**，Pi 默认 **7332**。两个引擎独立运行，不修改全局 Codex CLI。

```sh
# 单独启动引擎（claude-code 可换成 pi）
npm start -- --harness claude-code

# 修改两个入口的 SSH 端口
npm start -- --claude-port 7441 --pi-port 7442

# 单引擎自定义端口
npm start -- --harness pi --port 7442

# 检查指定引擎 / 查看 SSH 配置
npm run doctor -- --harness pi
npm run ssh-config -- --harness pi --port 7442
```

自定义端口每次启动都需传入，并同步更新桌面连接。`--home <目录>` 可更改状态目录，诊断和查看配置时也需传入。

- **启动失败：** 运行对应引擎的 `doctor`，按提示处理；详细日志在 `~/.codex-harness-adapter/<引擎>/`。
- **连接失败：** 确认服务仍在运行，端口和私钥与启动输出一致。
- **模型不可用：** 先在原生 Claude Code / Pi 中检查登录和模型配置。

[更多配置](docs/guide/configuration.md) · [开发说明](CONTRIBUTING.md)

---

基于 [fuergaosi233/claude-codex](https://github.com/fuergaosi233/claude-codex)，通用 SSH 实现来自 Tyrs Hand。[MIT](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)
