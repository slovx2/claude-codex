package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 捕获真实命令输出，防止内部字段、子进程警告或堆栈重新进入用户终端。
func captureTerminal(t *testing.T, action func() error) (string, error) {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "terminal-")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	stdout, stderr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = file, file
	defer func() { os.Stdout, os.Stderr = stdout, stderr }()
	actionErr := action()
	if actionErr != nil {
		fmt.Fprintln(file, actionErr)
	}
	output, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	return string(output), actionErr
}

func assertCleanTerminal(t *testing.T, output string) {
	t.Helper()
	for _, internal := range []string{"releaseReady", "ExperimentalWarning", "cliSha256", "at internal", "pty-self-check ok", "INTERNAL_DETAIL"} {
		if strings.Contains(output, internal) {
			t.Fatalf("用户终端泄漏 %s: %s", internal, output)
		}
	}
}

func TestDoctorShowsResultAndKeepsDetailsInLog(t *testing.T) {
	cfg := testConfiguration(t)
	writeStartFixture(t, cfg)
	fixture := `console.error('ExperimentalWarning: SQLite INTERNAL_DETAIL');
if (process.argv.includes('--runtime-info')) console.log(JSON.stringify({engine:'pi',protocolVersion:'0.157.1',releaseReady:false,cliSha256:'INTERNAL_DETAIL'}));
else console.log('pty-self-check ok');`
	if err := os.WriteFile(cfg.adapter(), []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	output, err := captureTerminal(t, func() error { return doctor(t.Context(), cfg) })
	if err != nil || !strings.Contains(output, "检查通过") {
		t.Fatalf("没有明确成功结论: %s %v", output, err)
	}
	assertCleanTerminal(t, output)
	log, err := os.ReadFile(filepath.Join(cfg.directory(), "diagnostics.log"))
	if err != nil || !strings.Contains(string(log), "releaseReady") || !strings.Contains(string(log), "ExperimentalWarning") || !strings.Contains(string(log), "pty-self-check ok") {
		t.Fatalf("诊断证据丢失: %s %v", log, err)
	}
}

func TestDiagnosticFailuresRemainActionable(t *testing.T) {
	for _, scenario := range []struct{ name, fixture, message string }{
		{"missing-cli", `console.error('Error: 宿主 CLI 不可执行或未找到: pi\n    at internal INTERNAL_DETAIL'); process.exit(1);`, "未找到可用的引擎 CLI"},
		{"invalid-response", `console.log('INTERNAL_DETAIL invalid JSON');`, "检查结果无效"},
		{"unexpected-error", `console.error('Error: INTERNAL_DETAIL\n    at internal'); process.exit(1);`, "重新安装和构建"},
		{"old-cli", `console.error('需要用户安装的 Pi CLI >= 0.99.1 INTERNAL_DETAIL'); process.exit(1);`, "最低稳定版本"},
		{"sandbox", `console.error('Claude 沙箱依赖不可用: bwrap INTERNAL_DETAIL'); process.exit(1);`, "沙箱依赖不可用"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			cfg := testConfiguration(t)
			writeStartFixture(t, cfg)
			if err := os.WriteFile(cfg.adapter(), []byte(scenario.fixture), 0o600); err != nil {
				t.Fatal(err)
			}
			output, err := captureTerminal(t, func() error { return doctor(t.Context(), cfg) })
			if err == nil || !strings.Contains(output, scenario.message) || !strings.Contains(output, "diagnostics.log") {
				t.Fatalf("缺少失败原因或排障路径: %s %v", output, err)
			}
			assertCleanTerminal(t, output)
			log, err := os.ReadFile(filepath.Join(cfg.directory(), "diagnostics.log"))
			if err != nil || !strings.Contains(string(log), "INTERNAL_DETAIL") {
				t.Fatalf("失败证据丢失: %s %v", log, err)
			}
		})
	}
}

func TestStartKeepsRuntimeOutputInLog(t *testing.T) {
	for _, crash := range []bool{false, true} {
		t.Run(fmt.Sprint(crash), func(t *testing.T) {
			cfg := testConfiguration(t)
			writeStartFixture(t, cfg)
			fixture, err := os.ReadFile(cfg.adapter())
			if err != nil {
				t.Fatal(err)
			}
			prefix := `console.error('ExperimentalWarning: SQLite INTERNAL_DETAIL');
if (!process.argv.includes('--runtime-info')) { console.log('INTERNAL_DETAIL stdout'); console.error('INTERNAL_DETAIL stderr');`
			if crash {
				prefix += `process.exit(1);`
			}
			prefix += "}\n"
			if err := os.WriteFile(cfg.adapter(), append([]byte(prefix), fixture...), 0o600); err != nil {
				t.Fatal(err)
			}
			output, startErr := captureTerminal(t, func() error {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				if crash {
					return start(ctx, cfg)
				}
				done := make(chan error, 1)
				go func() { done <- start(ctx, cfg) }()
				waitStartedHarness(t, cfg, done)
				cancel()
				return <-done
			})
			if crash && (startErr == nil || !strings.Contains(output, "引擎启动失败") || !strings.Contains(output, "runtime.log")) {
				t.Fatalf("运行失败被隐藏: %s %v", output, startErr)
			}
			if !crash && (startErr != nil || !strings.Contains(output, "SSH 就绪")) {
				t.Fatalf("入口未启动: %s %v", output, startErr)
			}
			assertCleanTerminal(t, output)
			log, err := os.ReadFile(filepath.Join(cfg.directory(), "runtime.log"))
			if err != nil || !strings.Contains(string(log), "INTERNAL_DETAIL stderr") || !strings.Contains(string(log), "INTERNAL_DETAIL stdout") {
				t.Fatalf("运行日志丢失: %s %v", log, err)
			}
		})
	}
}
