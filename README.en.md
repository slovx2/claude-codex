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

Source builds use these pinned versions:

| Component | Version |
| --- | --- |
| Node.js | 24.14.0 |
| Go | 1.26.6 |
| Claude Agent SDK | 0.3.282 |
| Claude Code CLI baseline | 2.1.282 |
| Pi SDK / CLI baseline | 0.99.1 |

Dependency versions are recorded in package.json, lockfiles, and `protocol/versions.json`. At runtime, the adapter checks the minimum supported host CLI version. It does not install or upgrade your CLI automatically.

Terminal features on macOS and Linux require Python 3, a POSIX shell, and standard system utilities. Claude on Linux also requires bubblewrap, socat, and working user namespaces. macOS uses the system sandbox-exec. Missing sandbox dependencies produce an error; execution does not silently fall back to an unsandboxed mode.

Windows uses native ConPTY, named pipes, and Job Objects, without requiring WSL or Python. It requires Windows 10/11 with ConPTY support, Git for Windows, and the pinned Node.js and Go versions. SSH sessions use Git Bash as their login shell; set `CLAUDE_CODE_GIT_BASH_PATH` to specify `bash.exe`. Windows CI runs on Windows Server 2025 x64.

**Windows sandbox limitation:** Native Claude on Windows does not provide an OS sandbox. Commands can run when you explicitly select full access. Restricted Bash execution in read-only, workspace sandbox, or plan mode produces an error instead of automatically widening permissions. If you need an OS sandbox, run the Linux setup inside WSL2. File tools still follow the adapter's approval and path checks.

Install the official Claude Code or Pi CLI you intend to use, then configure models and sign in through that native tool. Set `CHA_CLAUDE_CLI` or `PI_CLI` to specify a CLI path. Native settings such as `CLAUDE_CONFIG_DIR` and `PI_CODING_AGENT_DIR` remain managed by their respective harnesses.

## Build from source

```sh
git clone https://github.com/slovx2/codex-harness-adapter.git
cd codex-harness-adapter
npm ci
npm ci --prefix packages/claude
npm ci --prefix packages/pi
npm run build
./bin/codex-harness-adapter doctor
```

On Windows, run the same clone, npm install, and build commands in PowerShell, then use the `.exe`:

```powershell
.\bin\codex-harness-adapter.exe doctor
.\bin\codex-harness-adapter.exe init --harness claude-code
.\bin\codex-harness-adapter.exe ssh-config --harness claude-code
.\bin\codex-harness-adapter.exe serve --harness claude-code
```

For Pi, change `--harness` to `pi`. The default state directory is `%USERPROFILE%\.codex-harness-adapter`.
The private key directory receives an ACL restricted to the current Windows user. Enable Windows OpenSSH Client to test the connection.
After adding the configuration to `%USERPROFILE%\.ssh\config`, check the endpoint with `ssh codex-harness-adapter-claude 'codex --version'`.
You can also use `npm run doctor` and `npm start -- --harness pi` on all platforms.

Automated native Windows SSH/SDK checks do not constitute Codex Desktop GUI acceptance. Verification with the actual desktop client is still pending.

To check a single harness:

```sh
./bin/codex-harness-adapter doctor --harness pi
```

`doctor` checks runtime identity, versions, and a real PTY. Model authentication must be verified through an actual session.

## Connect Claude Code

```sh
./bin/codex-harness-adapter init --harness claude-code
./bin/codex-harness-adapter ssh-config --harness claude-code
./bin/codex-harness-adapter serve --harness claude-code
```

Manually add the complete output of `ssh-config` to `~/.ssh/config` and keep `serve` running in the foreground. In Codex Desktop's connection settings, select **codex-harness-adapter-claude** and add your project directory.

## Connect Pi

Run these commands in another terminal:

```sh
./bin/codex-harness-adapter init --harness pi
./bin/codex-harness-adapter ssh-config --harness pi
./bin/codex-harness-adapter serve --harness pi
```

After adding the corresponding SSH configuration, select **codex-harness-adapter-pi** in the desktop client. Both endpoints can run at the same time.

The default ports are 7331 for Claude Code and 7332 for Pi. To use a different port, pass the same `--port` value to `init`, `ssh-config`, and `serve`. All endpoints bind exclusively to `127.0.0.1`, accept only their dedicated public key, and do not provide general-purpose port forwarding.

Press Ctrl-C to stop the foreground service. It cleans up its own runtime processes and socket while preserving sessions and logs.

## State and troubleshooting

State is stored in `~/.codex-harness-adapter/<harness>/` by default. Use `--home` to select a different state root, `--node` to specify the Node.js executable, and `--root` to specify the source repository root.

- **Connection is missing:** Make sure the SSH configuration is saved. Run `ssh codex-harness-adapter-pi 'codex --version'` to verify the endpoint.
- **Runtime fails to start:** Run `doctor --harness <name>` and inspect `runtime.log` in that harness's state directory.
- **Port or state directory is already in use:** Stop the existing service, or choose a different `--home` and `--port` for the new instance.
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
