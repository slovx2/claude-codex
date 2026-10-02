package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/slovx2/codex-harness-adapter/sshserver"
	"golang.org/x/crypto/ssh"
)

func initialize(c configuration) error {
	if c.harness == "" {
		return errors.New("必须指定 --harness")
	}
	if err := os.MkdirAll(c.directory(), 0o700); err != nil {
		return err
	}
	clientPath := filepath.Join(c.directory(), "identity")
	if _, err := os.Stat(clientPath); errors.Is(err, os.ErrNotExist) {
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		block, err := ssh.MarshalPrivateKey(key, "codex-harness-adapter")
		if err != nil {
			return err
		}
		file, err := os.OpenFile(clientPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		_, writeErr := file.Write(pem.EncodeToMemory(block))
		if err := errors.Join(writeErr, file.Close()); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	client, err := readIdentity(clientPath)
	if err != nil {
		return err
	}
	if err := os.WriteFile(clientPath+".pub", ssh.MarshalAuthorizedKey(client.PublicKey()), 0o600); err != nil {
		return err
	}
	host, err := sshserver.LoadOrCreateHostKey(filepath.Join(c.directory(), "host_key"))
	if err != nil {
		return err
	}
	known := fmt.Sprintf("[%s]:%d %s", "127.0.0.1", c.port, ssh.MarshalAuthorizedKey(host.PublicKey()))
	if err := os.WriteFile(filepath.Join(c.directory(), "known_hosts"), []byte(known), 0o600); err != nil {
		return err
	}
	fmt.Printf("已初始化 %s；主机指纹 %s\n", c.harness, ssh.FingerprintSHA256(host.PublicKey()))
	return nil
}

func readIdentity(path string) (ssh.Signer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("请先运行 init: %w", err)
	}
	return ssh.ParsePrivateKey(data)
}

func printSSHConfig(c configuration) error {
	if c.harness == "" {
		return errors.New("必须指定 --harness")
	}
	if _, err := readIdentity(filepath.Join(c.directory(), "identity")); err != nil {
		return err
	}
	// 输出可直接粘贴的 OpenSSH 配置；绝不修改用户的全局配置。
	quote := func(value string) string { return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"` }
	alias := c.harness
	if alias == "claude-code" {
		alias = "claude"
	}
	fmt.Printf("Host codex-harness-adapter-%s\n  HostName 127.0.0.1\n  Port %d\n  User local\n  IdentityFile %s\n  IdentitiesOnly yes\n  UserKnownHostsFile %s\n  StrictHostKeyChecking yes\n", alias, c.port, quote(filepath.Join(c.directory(), "identity")), quote(filepath.Join(c.directory(), "known_hosts")))
	return nil
}
