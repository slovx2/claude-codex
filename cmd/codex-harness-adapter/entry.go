package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type localRuntime struct{ socket string }

func (r localRuntime) ServeDesktop(connection net.Conn) error {
	upstream, err := net.DialTimeout("unix", r.socket, 5*time.Second)
	if err != nil {
		return err
	}
	defer upstream.Close()
	go func() {
		_, _ = io.Copy(upstream, connection)
		if socket, ok := upstream.(*net.UnixConn); ok {
			_ = socket.CloseWrite()
		}
	}()
	_, err = io.Copy(connection, upstream)
	return err
}

func installEntry(c configuration, version string) error {
	directory := filepath.Join(c.directory(), "entry-bin")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	entry := "#!/bin/sh\nexec " + quote(executable) + " entry " + quote(c.socket()) + " " + quote(version) + " \"$@\"\n"
	return os.WriteFile(filepath.Join(directory, "codex"), []byte(entry), 0o700)
}

func runEntry(ctx context.Context, args []string) error {
	if len(args) < 3 {
		return errors.New("内部入口参数不完整")
	}
	socket, version, command := args[0], args[1], strings.Join(args[2:], " ")
	switch command {
	case "--version", "-V":
		fmt.Println("codex-cli " + version)
		return nil
	case "app-server daemon start":
		connection, err := net.DialTimeout("unix", socket, 5*time.Second)
		if err != nil {
			return err
		}
		return connection.Close()
	case "app-server proxy":
		connection, err := net.DialTimeout("unix", socket, 5*time.Second)
		if err != nil {
			return err
		}
		defer connection.Close()
		stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
		defer stop()
		go func() { _, _ = io.Copy(connection, os.Stdin); _ = connection.(*net.UnixConn).CloseWrite() }()
		_, err = io.Copy(os.Stdout, connection)
		return err
	default:
		return fmt.Errorf("此入口不支持 codex %s", command)
	}
}
