package main

import (
	"context"
	"errors"
	"fmt"
	"os"
)

func start(ctx context.Context, c configuration) error {
	fmt.Printf("%s\n", "启动本地适配器；Codex 设置 → 连接 → SSH → 添加，可手动填写下方参数，也可将 Host 配置加入 ~/.ssh/config（Windows: %USERPROFILE%\\.ssh\\config）后选择别名。")
	fmt.Println("自动检测 Claude Code 和 Pi；缺失或启动失败的入口只告警，其他入口继续运行。只使用一个引擎可加 --harness claude-code 或 --harness pi。")
	return supervise(ctx, c.entries(), func(ctx context.Context, entry configuration) error {
		fmt.Printf("[%s] 正在检测本机 CLI 和运行环境…\n", entry.harness)
		return serveRuntime(ctx, entry, true)
	})
}

// 入口独立运行；失败只告警，退出时仍等待所有已启动服务清理完成。
func supervise(ctx context.Context, entries []configuration, launch func(context.Context, configuration) error) error {
	group, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan error, len(entries))
	for _, entry := range entries {
		go func() {
			err := launch(group, entry)
			if err != nil {
				err = fmt.Errorf("%s: %w", entry.harness, err)
			}
			results <- err
		}()
	}
	var failures []error
	for range entries {
		err := <-results
		if err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintf(os.Stderr, "警告：%v；此入口未运行，其他可用入口不受影响。\n", err)
			failures = append(failures, err)
		}
	}
	if ctx.Err() != nil {
		return nil
	}
	return errors.Join(append([]error{errors.New("没有可用的适配器入口。请检查上方原因，安装所需 CLI 或运行 npm run doctor")}, failures...)...)
}
