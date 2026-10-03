# codex-harness-adapter

[简体中文](README.md) | **English**

**Connect different coding harnesses to Codex Desktop.**

Use Claude Code or Pi through the SSH connection option in Codex Desktop. The adapter runs on your machine and uses each harness's own tools, sessions, and configuration.

Claude Code and Pi adapters are available for macOS, Linux, and native Windows. The project is under development. The client protocol is pinned to Codex app-server **0.157.1**; connection behavior needs to be verified again after desktop client updates.

## How it works

```text
Codex Desktop
    ├─ SSH 127.0.0.1:7331 → Claude adapter → Claude Code
    └─ SSH 127.0.0.1:7332 → Pi adapter     → Pi
```

Each endpoint has its own processes, host key, socket, adapter database, and logs. An endpoint wrapper provides the `codex` command inside SSH sessions. Your regular Codex CLI and global PATH remain unchanged.

The adapters map harness events, tool calls, approvals, and session history to the Codex protocol. Each harness continues to manage model execution and native sessions.

## Requirements

Your local tools only need to meet these minimum stable versions. **Newer versions are accepted; no downgrade or exact version installation is required.**

| Local tool | Minimum version |
| --- | --- |
| Node.js | 24.14.0 |
| Go | 1.26.6 |
| Claude Code CLI | 2.1.282 |
| Pi CLI | 0.99.1 |

Go is only needed to build from source. Runtime checks accept stable releases at or above the minimum and reject older or prerelease versions. The adapter does not install or upgrade your local CLI automatically. If you only use one harness, you only need that harness's CLI.

`npm run setup` installs the repository's SDK and plugin dependencies from lockfiles; you do not need to install them individually. Claude Agent SDK 0.3.282 and Pi SDK 0.99.1 are the current reproducible build baselines; see `protocol/versions.json` for the full combination. Exact dependency locks and CI versions support reproducible development checks. They are separate from both the minimum versions of your local tools and the Codex protocol version.

Terminal features on macOS and Linux require Python 3, a POSIX shell, and standard system utilities. Claude on Linux also requires bubblewrap, socat, and working user namespaces. macOS uses the system sandbox-exec. Missing sandbox dependencies produce an error; execution does not silently fall back to an unsandboxed mode.

Windows uses native ConPTY, named pipes, and Job Objects, without requiring WSL or Python. It requires Windows 10/11 with ConPTY support, Git for Windows, and Node.js and Go meeting the minimum versions above. SSH sessions use Git Bash as their login shell; set `CLAUDE_CODE_GIT_BASH_PATH` to specify `bash.exe`. Windows CI runs on Windows Server 2025 x64.

**Windows sandbox limitation:** Native Claude on Windows does not provide an OS sandbox. Commands can run when you explicitly select full access. Restricted Bash execution in read-only, workspace sandbox, or plan mode produces an error instead of automatically widening permissions. If you need an OS sandbox, run the Linux setup inside WSL2. File tools still follow the adapter's approval and path checks.

Install the official Claude Code or Pi CLI you intend to use, then configure models and sign in through that native tool. Set `CHA_CLAUDE_CLI` or `PI_CLI` to specify a CLI path. Native settings such as `CLAUDE_CONFIG_DIR` and `PI_CODING_AGENT_DIR` remain managed by their respective harnesses.

Installation guides: [Claude Code](https://code.claude.com/docs/en/setup) and [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#getting-started). Before building, run `node --version`, `npm --version`, `go version`, and `claude --version` or `pi --version` for your chosen harness. If a command is not found, reopen your terminal after installation and make sure it is on PATH.

## Build from source

```sh
git clone https://github.com/slovx2/codex-harness-adapter.git
cd codex-harness-adapter
npm run setup
npm start
```

These commands work on macOS, Linux, and Windows PowerShell. `setup` installs repository dependencies and builds the project. For subsequent launches, run this one command from the repository directory:

```sh
npm start
```

It automatically checks the Claude Code and Pi CLIs, versions, and runtime requirements, then initializes keys and state directories and starts each available harness. Separate `init` and `serve` commands are unnecessary. Existing keys are preserved. Logs show detection, startup, and SSH readiness for each harness. A missing CLI or startup failure produces a warning and **does not stop other available endpoints**. The command exits with an error only if no endpoints remain available.

Once the endpoint you need reports “SSH 就绪” (SSH ready), keep the terminal open. Press Ctrl-C to stop all endpoints started by this command.

To start just one harness:

```sh
npm start -- --harness claude-code
# or
npm start -- --harness pi
```

## Connect Codex Desktop for the first time

Keep `npm start` running, then follow these three steps:

1. **Optional: configure SSH aliases.** Add the complete `Host` blocks printed at startup to `~/.ssh/config` (`%USERPROFILE%\.ssh\config` on Windows). You can rename the value after `Host` to something recognizable, such as `claude-local` or `pi-local`; keep the other values from the startup output. Create the directory or file if needed.
2. **Add a device.** In Codex Desktop, open **Settings → Connections → SSH → Add**. Select the alias you configured, or choose **Add manually**. For manual setup, use the startup output: host `127.0.0.1`, the corresponding port, user `local`, and the dedicated private key indicated by `IdentityFile`. The host fingerprint should match the startup log.
3. **Add a project.** Return to the main screen, click **Add project** → open the **Remote devices** dropdown → select the device you just added → select and add your project directory. Even though the device is local, add the project through this SSH device to use its harness.

If you started only one harness, add only that device. Update the device's connection settings whenever you change its SSH port. See the [official OpenAI connection guide](https://learn.chatgpt.com/docs/remote-connections) for background.

Optional: after configuring aliases, verify the endpoints in another terminal (use your own names if you changed them):

```sh
ssh codex-harness-adapter-claude 'codex --version'
ssh codex-harness-adapter-pi 'codex --version'
```

On Windows, enable OpenSSH Client to run the `ssh` commands above. The private key directory receives an ACL restricted to the current Windows user. Automated native Windows SSH/SDK checks do not constitute Codex Desktop GUI acceptance; verification with the actual client is still pending.

To display SSH configuration again or check your environment:

```sh
npm run ssh-config -- --harness claude-code
npm run doctor -- --harness claude-code
# Check all harnesses
npm run doctor
```

Replace `claude-code` with `pi` to display or check Pi. Specify `--harness` when you only installed one harness. `doctor` checks runtime identity, versions, and a real PTY. Without a harness selection, it checks both and exits nonzero if either is missing or fails; this does not mean the other running endpoint is unavailable. Model authentication must be verified through an actual session.

Use the final “检查通过” (checks passed) message and exit code to assess the local environment check. The detailed `releaseReady: false` field means the project has not claimed complete release acceptance; Node's SQLite experimental warning alone does not indicate a failed check.

## Ports and advanced startup

The default ports are 7331 for Claude Code and 7332 for Pi. To change both:

```sh
npm start -- --claude-port 7441 --pi-port 7442
```

For a single endpoint, use `npm start -- --harness pi --port 7442`. After changing a port or state root, update your SSH configuration using the new startup output. All endpoints bind exclusively to `127.0.0.1`, accept only their dedicated public key, and do not provide general-purpose port forwarding.

Pass the port options on every launch and when displaying configuration again, for example `npm run ssh-config -- --harness pi --port 7442`. If you used `--home`, pass the same directory when displaying configuration or running diagnostics.

You can also run `./bin/codex-harness-adapter start` directly (`.\bin\codex-harness-adapter.exe start` on Windows). For manual initialization, `init`, `ssh-config`, and `serve --harness <name>` remain available. Without `--harness`, `init` initializes both endpoints; `ssh-config` displays initialized endpoints and warns about skipped, missing endpoints.

Press Ctrl-C to stop the foreground service. It cleans up its own runtime processes and socket while preserving sessions and logs.

## State and troubleshooting

State is stored in `~/.codex-harness-adapter/<harness>/` by default. Use `--home` to select a different state root, `--node` to specify the Node.js executable, and `--root` to specify the source repository root.

- **Connection is missing:** Make sure the SSH configuration is saved. Run `ssh codex-harness-adapter-pi 'codex --version'` to verify the endpoint.
- **Runtime fails to start:** Run `npm run doctor -- --harness claude-code` (or `pi`) and inspect `runtime.log` in that harness's state directory.
- **Port or state directory is already in use:** Stop the existing service, or choose a different `--home` and set `--claude-port` / `--pi-port` (`--port` for a single harness).
- **Models are missing or authentication fails:** Check configuration and sign-in through the native CLI.

Initialization preserves existing private keys and host keys. The service accesses local files as the current user; SSH access itself is not a filesystem sandbox.

### Data from earlier versions

This release introduces breaking changes. It does not read old adapter configuration names, migrate old adapter databases, or interpret the former `tyrs-*` session projection markers. Explicitly selecting an old database produces an error.

Old databases and native Claude/Pi session files are not automatically deleted or rewritten in bulk. Native tools can still use their native sessions, but restoring display metadata generated by the old adapter is not guaranteed.

## Development and integration

- `packages/claude`: Claude protocol and runtime adapter.
- `packages/pi`: Pi protocol and runtime adapter.
- `packages/shared`: Shared protocol, transport, file, terminal, and adapter metadata functionality.
- `sshserver`: A reusable Go SSH library with interfaces for injecting environment, authorization, and runtime behavior.
- `cmd/codex-harness-adapter`: Local foreground CLI.
- `protocol`: Pinned protocol contracts and version manifest.

```sh
npm run typecheck
npm run check
npm test
```

This project provides independently usable adapters and an SSH library. Control, Worker registration, Hub coordination, multi-client synchronization, business authorization, Discord, and deployment features remain in Tyrs Hand. Installing or running Tyrs Hand is not required. Tyrs Hand's dependency transition is handled separately.

## Origins and licensing

This project builds on [fuergaosi233/claude-codex](https://github.com/fuergaosi233/claude-codex), preserving its commit history and copyright notices. The generic SSH implementation was extracted from Tyrs Hand.

Project code is licensed under [MIT](LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Claude Agent SDK and Claude Code are not covered by this project's MIT license and are subject to Anthropic's terms.

This is an independent community project with no official affiliation with OpenAI, Anthropic, or the Pi maintainers.
