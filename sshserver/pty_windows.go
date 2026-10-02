package sshserver

import (
	"context"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/UserExistsError/conpty"
	"github.com/slovx2/codex-harness-adapter/internal/hostplatform"
	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/windows"
)

func (s *SSHServer) runPTY(channel ssh.Channel, state *sshSessionState, process *exec.Cmd) {
	terminal, err := conpty.Start(windows.ComposeCommandLine(process.Args), conpty.ConPtyDimensions(int(state.columns), int(state.rows)), conpty.ConPtyWorkDir(process.Dir), conpty.ConPtyEnv(process.Env))
	if err != nil {
		s.writeExit(channel, 1)
		return
	}
	cleanup, err := hostplatform.TrackPID(terminal.Pid())
	if err != nil {
		_ = terminal.Close()
		s.writeExit(channel, 1)
		return
	}
	var once sync.Once
	closeTerminal := func() { once.Do(func() { cleanup(); _ = terminal.Close() }) }
	defer closeTerminal()
	stop := context.AfterFunc(s.context, closeTerminal)
	defer stop()
	state.resize = func(cols, rows uint32) error { return terminal.Resize(int(cols), int(rows)) }
	drained := make(chan struct{})
	go func() { _, _ = io.Copy(terminal, channel); closeTerminal() }()
	go func() { _, _ = io.Copy(channel, terminal); close(drained) }()
	code, err := terminal.Wait(context.Background())
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
	}
	if err != nil {
		code = 1
	}
	s.writeExit(channel, code)
}
