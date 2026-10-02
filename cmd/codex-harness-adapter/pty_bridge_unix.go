//go:build !windows

package main

import "fmt"

func runPtyBridge(_ []string) int {
	fmt.Println(`{"event":"spawnError","message":"此平台使用 Python PTY 桥"}`)
	return 127
}
