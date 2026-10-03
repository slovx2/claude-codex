package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/slovx2/codex-harness-adapter/internal/hostplatform"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/slovx2/codex-harness-adapter/sshserver"
)

func serve(ctx context.Context, c configuration) error {
	return serveRuntime(ctx, c, false)
}

func serveRuntime(ctx context.Context, c configuration, autoInit bool) error {
	if c.harness == "" {
		return errors.New("必须指定 --harness")
	}
	if runtime.GOOS != "windows" && len(c.socket()) > 100 {
		return errors.New("状态路径过长，无法创建 Unix socket；请使用较短的 --home")
	}
	if err := os.MkdirAll(c.directory(), 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(c.directory(), "serve.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := hostplatform.Lock(lock); err != nil {
		return errors.New("此 harness 状态目录已有运行进程")
	}
	defer hostplatform.Unlock(lock)
	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	probe := exec.CommandContext(probeCtx, c.node, c.adapter(), "--runtime-info")
	probe.Env = c.environment()
	output, err := probe.Output()
	probeErr := probeCtx.Err()
	cancel()
	if err != nil {
		if probeErr != nil {
			return probeErr
		}
		var failure *exec.ExitError
		if errors.As(err, &failure) {
			return fmt.Errorf("运行时检查失败，请运行 npm run doctor -- --harness %s: %w\n%s", c.harness, err, failure.Stderr)
		}
		return fmt.Errorf("运行时检查失败，请先 npm run build 并检查 Node 路径: %w", err)
	}
	var info struct {
		Engine          string `json:"engine"`
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := json.Unmarshal(output, &info); err != nil {
		return err
	}
	if info.Engine != c.harness || info.ProtocolVersion == "" {
		return errors.New("运行时身份不匹配")
	}
	if autoInit {
		fmt.Printf("[%s] 检测通过，正在初始化并启动…\n", c.harness)
		if err := initialize(c); err != nil {
			return err
		}
	}
	identity, err := readIdentity(filepath.Join(c.directory(), "identity"))
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(c.directory(), "host_key")); err != nil {
		return errors.New("缺少 HostKey，请先运行 init")
	}
	version := info.ProtocolVersion + " (codex-harness-adapter-" + c.harness + ")"
	if err := installEntry(c, version); err != nil {
		return err
	}
	// 仅持有状态锁的进程可以清理本入口遗留的 socket。
	if err := hostplatform.RemoveSocket(c.socket()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	defer hostplatform.RemoveSocket(c.socket())
	log, err := os.OpenFile(filepath.Join(c.directory(), "runtime.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	process := exec.Command(c.node, c.adapter(), "app-server", "--listen", hostplatform.ListenURL(c.socket()))
	process.Env = c.environment()
	process.Stdout, process.Stderr = log, io.MultiWriter(os.Stderr, log)
	hostplatform.Prepare(process)
	if err := process.Start(); err != nil {
		return err
	}
	cleanup, err := hostplatform.Track(process)
	if err != nil {
		_ = hostplatform.Kill(process)
		_ = process.Wait()
		return err
	}
	defer cleanup()
	done := make(chan struct{})
	var waitErr error
	go func() { waitErr = process.Wait(); close(done) }()
	defer func() {
		_ = hostplatform.Terminate(process)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = hostplatform.Kill(process)
			<-done
		}
	}()
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	ready := false
	for !ready {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return fmt.Errorf("运行时提前退出: %v", waitErr)
		case <-deadline.C:
			return errors.New("等待运行时 socket 超时")
		case <-ticker.C:
			connection, err := hostplatform.Dial(c.socket())
			if err == nil {
				_ = connection.Close()
				ready = true
			}
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	shell := hostplatform.DefaultShell()
	server, err := sshserver.StartSSHServer(ctx, sshserver.SSHOptions{
		ListenAddr: fmt.Sprintf("127.0.0.1:%d", c.port), HostKeyFile: filepath.Join(c.directory(), "host_key"),
		Home: home, CodexHome: filepath.Join(c.directory(), "codex"), Shell: shell,
		AuthorizedClients: []sshserver.AuthorizedClient{{ID: "local", PublicKey: identity.PublicKey()}},
		Runtime:           localRuntime{socket: c.socket()}, EntryBin: filepath.Join(c.directory(), "entry-bin"),
		Environment: c.environment,
		Command: func(_ context.Context, command string, channel io.ReadWriteCloser) (bool, uint32) {
			switch strings.TrimSpace(command) {
			case "codex --version", "codex -V":
				_, _ = fmt.Fprintln(channel, "codex-cli "+version)
				return true, 0
			case "codex app-server daemon start":
				select {
				case <-done:
					return true, 1
				default:
					return true, 0
				}
			}
			return false, 0
		},
	})
	if err != nil {
		return err
	}
	defer server.Close()
	fmt.Printf("%s SSH 就绪: %s；按 Ctrl-C 停止\n", c.harness, server.Addr())
	if autoInit {
		if err := printSSHConfig(c); err != nil {
			return err
		}
	}
	select {
	case <-ctx.Done():
		return nil
	case <-done:
		return fmt.Errorf("%s 运行时已退出: %v", c.harness, waitErr)
	}
}
