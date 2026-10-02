package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
)

type configuration struct {
	harness, home, root, node string
	port                      int
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("用法: codex-harness-adapter init|serve|ssh-config|doctor --harness claude-code|pi [--port PORT]")
	}
	if args[0] == "entry" {
		return runEntry(ctx, args[1:])
	}
	command := args[0]
	if command != "init" && command != "serve" && command != "ssh-config" && command != "doctor" {
		return fmt.Errorf("未知命令: %s", command)
	}
	cfg, err := parseConfiguration(args[1:])
	if err != nil {
		return err
	}
	switch command {
	case "init":
		return initialize(cfg)
	case "ssh-config":
		return printSSHConfig(cfg)
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
	if err := flags.Parse(args); err != nil {
		return cfg, err
	}
	if flags.NArg() != 0 {
		return cfg, errors.New("不接受位置参数")
	}
	if cfg.harness != "" && cfg.harness != "claude-code" && cfg.harness != "pi" {
		return cfg, errors.New("harness 必须为 claude-code 或 pi")
	}
	if cfg.port == 0 {
		cfg.port = 7331
		if cfg.harness == "pi" {
			cfg.port = 7332
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

func (c configuration) directory() string { return filepath.Join(c.home, c.harness) }
func (c configuration) socket() string    { return filepath.Join(c.directory(), "runtime.sock") }
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
	command := exec.CommandContext(ctx, c.node, c.adapter(), "--runtime-info")
	command.Env = c.environment()
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s 运行时检查失败: %w\n%s", c.harness, err, output)
	}
	fmt.Printf("%s: %s", c.harness, output)
	command = exec.CommandContext(ctx, c.node, c.adapter(), "--pty-self-check")
	command.Env = c.environment()
	output, err = command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s PTY 检查失败: %w\n%s", c.harness, err, output)
	}
	fmt.Printf("%s: %s", c.harness, output)
	return nil
}
