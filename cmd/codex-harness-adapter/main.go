package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"github.com/slovx2/codex-harness-adapter/internal/hostplatform"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
)

type configuration struct {
	harness, home, root, node string
	port                      int
	claudePort, piPort        int
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "pty-bridge" {
		os.Exit(runPtyBridge(os.Args[2:]))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		fmt.Println("用法: codex-harness-adapter start|init|serve|ssh-config|doctor [选项]\nstart: 自动初始化并启动可用的 Claude Code 和 Pi；可用 --harness claude-code|pi 仅启动一个\n全部启动端口: --claude-port 7331 --pi-port 7332\n单入口端口: --harness claude-code|pi --port PORT\n公共选项: --home DIR --node PATH --root DIR\n首次连接: Codex 设置 → 连接 → SSH → 添加；可选将输出的配置加入 ~/.ssh/config；Ctrl-C 停止全部入口")
		return nil
	}
	if args[0] == "entry" {
		return runEntry(ctx, args[1:])
	}
	command := args[0]
	if command != "start" && command != "init" && command != "serve" && command != "ssh-config" && command != "doctor" {
		return fmt.Errorf("未知命令: %s", command)
	}
	cfg, err := parseConfiguration(args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	switch command {
	case "start":
		return start(ctx, cfg)
	case "init":
		for _, entry := range cfg.entries() {
			if err := initialize(entry); err != nil {
				return err
			}
		}
		return nil
	case "ssh-config":
		var failures []error
		printed := false
		for _, entry := range cfg.entries() {
			if err := printSSHConfig(entry); err != nil {
				failures = append(failures, fmt.Errorf("%s: %w", entry.harness, err))
				fmt.Fprintf(os.Stderr, "警告：跳过 %s，请先启动或初始化此入口: %v\n", entry.harness, err)
				continue
			}
			printed = true
		}
		if !printed {
			return errors.Join(failures...)
		}
		return nil
	case "serve":
		return serve(ctx, cfg)
	case "doctor":
		if cfg.harness != "" {
			return doctor(ctx, cfg)
		}
		var failures []error
		for _, harness := range []string{"claude-code", "pi"} {
			cfg.harness = harness
			failures = append(failures, doctor(ctx, cfg))
		}
		return errors.Join(failures...)
	}
	return nil
}

func parseConfiguration(args []string) (configuration, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return configuration{}, err
	}
	executable, err := os.Executable()
	if err != nil {
		return configuration{}, err
	}
	flags := flag.NewFlagSet("codex-harness-adapter", flag.ContinueOnError)
	cfg := configuration{}
	flags.StringVar(&cfg.harness, "harness", "", "claude-code 或 pi")
	flags.StringVar(&cfg.home, "home", filepath.Join(home, ".codex-harness-adapter"), "适配器状态根目录")
	flags.StringVar(&cfg.root, "root", filepath.Dir(filepath.Dir(executable)), "适配器源码根目录")
	flags.StringVar(&cfg.node, "node", "node", "Node 可执行文件")
	flags.IntVar(&cfg.port, "port", 0, "回环 SSH 端口")
	flags.IntVar(&cfg.claudePort, "claude-port", 7331, "全部启动时 Claude SSH 端口")
	flags.IntVar(&cfg.piPort, "pi-port", 7332, "全部启动时 Pi SSH 端口")
	if err := flags.Parse(args); err != nil {
		return cfg, err
	}
	if flags.NArg() != 0 {
		return cfg, errors.New("不接受位置参数")
	}
	if cfg.harness != "" && cfg.harness != "claude-code" && cfg.harness != "pi" {
		return cfg, errors.New("harness 必须为 claude-code 或 pi")
	}
	if cfg.harness == "" && cfg.port != 0 {
		return cfg, errors.New("--port 需要指定 --harness；全部启动请用 --claude-port 和 --pi-port")
	}
	if cfg.claudePort < 1 || cfg.claudePort > 65535 || cfg.piPort < 1 || cfg.piPort > 65535 || cfg.claudePort == cfg.piPort {
		return cfg, errors.New("Claude 和 Pi 端口必须不同，且在 1 到 65535 之间")
	}
	if cfg.port == 0 {
		cfg.port = cfg.claudePort
		if cfg.harness == "pi" {
			cfg.port = cfg.piPort
		}
	}
	if cfg.port < 1 || cfg.port > 65535 {
		return cfg, errors.New("端口必须为 1 到 65535")
	}
	cfg.home, err = filepath.Abs(cfg.home)
	if err != nil {
		return cfg, err
	}
	cfg.root, err = filepath.Abs(cfg.root)
	return cfg, err
}

func (c configuration) entries() []configuration {
	if c.harness != "" {
		return []configuration{c}
	}
	claude, pi := c, c
	claude.harness, claude.port = "claude-code", c.claudePort
	pi.harness, pi.port = "pi", c.piPort
	return []configuration{claude, pi}
}

func (c configuration) directory() string { return filepath.Join(c.home, c.harness) }
func (c configuration) socket() string    { return hostplatform.SocketPath(c.directory()) }
func (c configuration) adapter() string {
	name := "claude"
	if c.harness == "pi" {
		name = "pi"
	}
	return filepath.Join(c.root, "packages", name, "dist", name, "src", "adapter.mjs")
}

func (c configuration) environment() []string {
	values := map[string]string{
		"CODEX_HOME":      filepath.Join(c.directory(), "codex"),
		"CHA_CLAUDE_HOME": c.directory(), "CHA_PI_HOME": c.directory(),
		"CHA_CLAUDE_IDLE_EXIT_MS": "0",
	}
	result := []string{}
	for _, entry := range os.Environ() {
		keep := true
		for name := range values {
			if len(entry) > len(name) && entry[:len(name)+1] == name+"=" {
				keep = false
			}
		}
		if keep {
			result = append(result, entry)
		}
	}
	for name, value := range values {
		result = append(result, name+"="+value)
	}
	return result
}

func doctor(ctx context.Context, c configuration) error {
	if runtime.GOOS == "windows" {
		if _, err := exec.LookPath(hostplatform.DefaultShell()); err != nil {
			return fmt.Errorf("Windows SSH 需要 Git for Windows 的 bash.exe: %w", err)
		}
		if c.harness == "claude-code" {
			fmt.Println("Windows 上的 Claude 命令执行需要显式选择完全访问；需要系统沙箱时请使用 WSL2。")
		}
	}
	if _, err := inspectRuntime(ctx, c); err != nil {
		return fmt.Errorf("[%s] %w", c.harness, err)
	}
	if _, err := runDiagnostic(ctx, c, "--pty-self-check"); err != nil {
		return fmt.Errorf("[%s] %w", c.harness, err)
	}
	fmt.Printf("[%s] 检查通过：引擎与终端可用。\n", c.harness)
	fmt.Println("下一步：运行 npm start 并连接 Codex；模型登录和回复请在会话中确认。")
	return nil
}
