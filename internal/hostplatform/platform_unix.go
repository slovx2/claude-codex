//go:build !windows

package hostplatform

import (
	"net"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func Lock(file *os.File) error            { return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) }
func Unlock(file *os.File)                { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }
func Prepare(cmd *exec.Cmd)               { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func Kill(cmd *exec.Cmd) error            { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
func Terminate(cmd *exec.Cmd) error       { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
func Track(cmd *exec.Cmd) (func(), error) { return func() {}, nil }
func Dial(path string) (net.Conn, error)  { return net.DialTimeout("unix", path, 5*time.Second) }
func CloseWrite(connection net.Conn) {
	if c, ok := connection.(*net.UnixConn); ok {
		_ = c.CloseWrite()
	}
}
func SocketPath(home string) string  { return home + "/runtime.sock" }
func ListenURL(path string) string   { return "unix://" + path }
func RemoveSocket(path string) error { return os.Remove(path) }
func DefaultShell() string {
	if value := os.Getenv("SHELL"); value != "" {
		return value
	}
	return "/bin/sh"
}
func ShellPath(path string) string { return path }
func Protect(path string) error    { return nil }
