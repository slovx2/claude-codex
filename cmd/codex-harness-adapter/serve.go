package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/slovx2/codex-harness-adapter/internal/hostplatform"
	"io"
	"net"
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
	info, err := inspectRuntime(ctx, c)
	if err != nil {
		return err
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
	log, err := openLocalLog(c, "runtime.log")
	if err != nil {
		return err
	}
	defer log.Close()
	process := exec.Command(c.node, c.adapter(), "app-server", "--listen", hostplatform.ListenURL(c.socket()))
	process.Env = c.environment()
	process.Stdout, process.Stderr = log, log
	runtimeFailure := func(message string, cause error) error {
		fmt.Fprintf(log, "\n%s: %v\n", message, cause)
		return fmt.Errorf("%s，请重试；若仍失败，请查看日志 %s", message, filepath.Join(c.directory(), "runtime.log"))
	}
	hostplatform.Prepare(process)
	if err := process.Start(); err != nil {
		return runtimeFailure("引擎启动失败", err)
	}
	cleanup, err := hostplatform.Track(process)
	if err != nil {
		_ = hostplatform.Kill(process)
		_ = process.Wait()
		return runtimeFailure("无法管理引擎进程", err)
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
			return runtimeFailure("引擎启动失败", waitErr)
		case <-deadline.C:
			return runtimeFailure("引擎启动超时", context.DeadlineExceeded)
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
		return runtimeFailure("无法读取用户主目录", err)
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
		var operation *net.OpError
		if errors.As(err, &operation) && operation.Op == "listen" {
			fmt.Fprintf(log, "\nSSH 监听失败: %v\n", err)
			return fmt.Errorf("SSH 端口 %d 无法使用，请关闭占用程序或更改此引擎的 SSH 端口", c.port)
		}
		return runtimeFailure("SSH 入口启动失败", err)
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
		return runtimeFailure("引擎已停止", waitErr)
	}
}
