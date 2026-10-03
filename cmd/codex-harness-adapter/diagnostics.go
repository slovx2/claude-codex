package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/slovx2/codex-harness-adapter/internal/hostplatform"
)

type runtimeDetails struct {
	Engine          string `json:"engine"`
	ProtocolVersion string `json:"protocolVersion"`
}

// 原始诊断只保存在本入口的私有日志中，不把 JSON、警告和堆栈混入用户输出。
func openLocalLog(c configuration, name string) (*os.File, error) {
	if err := os.MkdirAll(c.directory(), 0o700); err != nil {
		return nil, fmt.Errorf("无法创建状态目录，请检查目录权限: %w", err)
	}
	if err := hostplatform.Protect(c.directory()); err != nil {
		return nil, fmt.Errorf("无法保护状态目录，请检查目录权限: %w", err)
	}
	path := filepath.Join(c.directory(), name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("无法写入日志，请检查目录权限: %w", err)
	}
	if err := hostplatform.Protect(path); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("无法保护日志文件: %w", err)
	}
	return file, nil
}

func diagnosticError(c configuration, message string) error {
	return fmt.Errorf("%s；详细日志：%s", message, filepath.Join(c.directory(), "diagnostics.log"))
}

func runDiagnostic(ctx context.Context, c configuration, flag string) ([]byte, error) {
	log, err := openLocalLog(c, "diagnostics.log")
	if err != nil {
		return nil, err
	}
	defer log.Close()
	fmt.Fprintf(log, "\n[%s] %s\n", time.Now().Format(time.RFC3339), flag)
	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(probeCtx, c.node, c.adapter(), flag)
	command.Env = c.environment()
	var output, stderr bytes.Buffer
	command.Stdout = io.MultiWriter(&output, log)
	command.Stderr = io.MultiWriter(&stderr, log)
	err = command.Run()
	if err == nil {
		return output.Bytes(), nil
	}
	fmt.Fprintf(log, "\n检查失败: %v\n", err)
	if errors.Is(probeCtx.Err(), context.Canceled) {
		return nil, context.Canceled
	}
	message := "环境检查失败，请运行 npm run setup 重新安装和构建"
	switch {
	case errors.Is(probeCtx.Err(), context.DeadlineExceeded):
		message = "环境检查超时，请确认本机引擎命令可以正常运行后重试"
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist):
		message = "无法启动 Node.js，请确认已安装并加入 PATH，或使用 --node 指定路径"
	case flag == "--pty-self-check":
		message = "终端检查失败，请检查系统终端依赖；Windows 需要 Git for Windows，macOS/Linux 需要 Python 3"
	case strings.Contains(stderr.String(), "CLI 不可执行或未找到"):
		message = "未找到可用的引擎 CLI，请安装后重开终端，或通过 CHA_CLAUDE_CLI / PI_CLI 指定路径"
	case strings.Contains(stderr.String(), "Claude CLI 版本不符"), strings.Contains(stderr.String(), "需要用户安装的 Pi CLI"):
		message = "引擎 CLI 版本检查未通过，请安装 README 要求的最低稳定版本或更高版本"
	case strings.Contains(stderr.String(), "无法读取宿主 Claude CLI 版本"):
		message = "无法读取 Claude Code 版本，请先确认 claude --version 可以正常运行"
	case strings.Contains(stderr.String(), "需要 Node >="):
		message = "Node.js 版本过低，请安装 README 要求的最低稳定版本或更高版本"
	case strings.Contains(stderr.String(), "沙箱依赖不可用"):
		message = "沙箱依赖不可用，请检查 Linux 的 bubblewrap、socat 或 macOS 的 sandbox-exec"
	}
	return nil, diagnosticError(c, message)
}

func inspectRuntime(ctx context.Context, c configuration) (runtimeDetails, error) {
	output, err := runDiagnostic(ctx, c, "--runtime-info")
	var info runtimeDetails
	if err != nil {
		return info, err
	}
	if err := json.Unmarshal(output, &info); err != nil || info.Engine != c.harness || info.ProtocolVersion == "" {
		return info, diagnosticError(c, "环境检查结果无效，请运行 npm run setup 重新构建")
	}
	return info, nil
}
