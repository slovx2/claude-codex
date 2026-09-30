"""PTY 字节桥：语义对齐 Codex codex-utils-pty（portable-pty）。

- 启动握手：exec 成功输出 {"event":"spawned","pid":N}，失败输出 {"event":"spawnError"} 并以 127 退出；
- 终止（kill 指令、SIGTERM/SIGINT、stdin EOF）立即向整个进程组发送 SIGKILL；
- 子进程退出后最多再排空 2 秒输出，然后回收进程组；被信号终止时退出码为 1。
"""

import argparse
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
from typing import Any

IO_DRAIN_TIMEOUT_SECONDS = 2.0


def emit(message: dict[str, Any]) -> None:
    print(json.dumps(message), flush=True)


def resize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=24)
    parser.add_argument("--cols", type=int, default=80)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command: list[str] = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        emit({"event": "spawnError", "message": "command must not be empty"})
        return 127
    master, slave = pty.openpty()
    resize(slave, args.rows, args.cols)
    # os.pipe() 默认不可继承：exec 成功时写端自动关闭，父进程读到 EOF 即启动成功。
    ready_read, ready_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.close(ready_read)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for descriptor in (0, 1, 2):
            os.dup2(slave, descriptor)
        if slave > 2:
            os.close(slave)
        try:
            os.execvp(command[0], command)
        except OSError as error:
            os.write(ready_write, str(error).encode("utf-8", "replace"))
            os._exit(127)
    os.close(slave)
    os.close(ready_write)
    failure = b""
    while chunk := os.read(ready_read, 4096):
        failure += chunk
    os.close(ready_read)
    if failure:
        os.waitpid(pid, 0)
        os.close(master)
        emit({"event": "spawnError", "message": failure.decode("utf-8", "replace")})
        return 127
    emit({"event": "spawned", "pid": pid})

    buffer = b""
    status: int | None = None
    exited_at: float | None = None
    output_open = True
    stdin_open = True

    def terminate(_sig: int = 0, _frame: Any = None) -> None:
        kill_group(pid)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        while status is None or output_open:
            if status is None:
                exited, child_status = os.waitpid(pid, os.WNOHANG)
                if exited:
                    status = child_status
                    exited_at = time.monotonic()
            elif exited_at is not None and time.monotonic() - exited_at >= IO_DRAIN_TIMEOUT_SECONDS:
                break
            readers = ([master] if output_open else []) + ([0] if stdin_open and status is None else [])
            readable, _, _ = select.select(readers, [], [], 0.05)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    emit({"stream": "stdout", "delta": base64.b64encode(data).decode("ascii")})
                else:
                    output_open = False
            if 0 in readable:
                data = os.read(0, 65536)
                if not data:
                    stdin_open = False
                    terminate()
                    continue
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    message: dict[str, Any] = json.loads(line)
                    action = message.get("action")
                    if action == "input":
                        os.write(master, base64.b64decode(message["data"], validate=True))
                    elif action == "resize":
                        resize(master, int(message["rows"]), int(message["cols"]))
                    elif action == "eof":
                        os.write(master, b"\x04")
                    elif action == "kill":
                        terminate()
        if status is None:
            _, status = os.waitpid(pid, 0)
        # portable-pty 对信号终止报告退出码 1。
        return os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
    finally:
        kill_group(pid)
        if status is None:
            os.waitpid(pid, 0)
        os.close(master)


if __name__ == "__main__":
    sys.exit(main())
