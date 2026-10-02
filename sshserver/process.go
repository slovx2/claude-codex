// Copyright (c) 2026 tyrs-hand contributors. SPDX-License-Identifier: MIT
package sshserver

import (
	"errors"
	"github.com/creack/pty"
	"golang.org/x/crypto/ssh"
	"io"
	"os/exec"
	"strings"
)

func (s *SSHServer) runPTY(channel ssh.Channel, state *sshSessionState, process *exec.Cmd) {
	terminal, err := pty.StartWithSize(process, &pty.Winsize{
		Cols: uint16(state.columns), Rows: uint16(state.rows),
	})
	if err != nil {
		s.writeExit(channel, 1)
		return
	}
	state.process = terminal
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(terminal, channel)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(channel, terminal)
		done <- struct{}{}
	}()
	err = process.Wait()
	_ = terminal.Close()
	<-done
	s.writeExit(channel, exitStatus(err))
}

func (s *SSHServer) writeExit(channel ssh.Channel, status uint32) {
	_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
}

func allowedSSHEnvironment(name string) bool {
	switch name {
	case "LANG", "LC_ALL", "LC_CTYPE", "COLORTERM", "TERM_PROGRAM":
		return true
	default:
		return strings.HasPrefix(name, "LC_")
	}
}

func exitStatus(err error) uint32 {
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() >= 0 {
		return uint32(exit.ExitCode())
	}
	return 1
}
