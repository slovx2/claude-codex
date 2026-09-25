"""PTY 字节桥：传播真实退出码、初始尺寸和 resize，并回收整个进程组。"""

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


def resize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def kill_group(pid: int, sig: int) -> None:
    try:
        os.killpg(pid, sig)
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
        return 127
    master, slave = pty.openpty()
    resize(slave, args.rows, args.cols)
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for descriptor in (0, 1, 2):
            os.dup2(slave, descriptor)
        if slave > 2:
            os.close(slave)
        try:
            os.execvp(command[0], command)
        except OSError as error:
            print(str(error), file=sys.stderr, flush=True)
            os._exit(127)
    os.close(slave)
    buffer = b""
    status: int | None = None
    stopping: float | None = None
    output_open = True

    def stop(_sig: int = 0, _frame: Any = None) -> None:
        nonlocal stopping
        if stopping is None:
            stopping = time.monotonic()
            kill_group(pid, signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while status is None or output_open:
            if status is None:
                exited, child_status = os.waitpid(pid, os.WNOHANG)
                if exited:
                    status = child_status
                    # Shell 退出后不能让后台孙进程继续持有 PTY。
                    stop()
            if stopping is not None and time.monotonic() - stopping >= 0.5:
                kill_group(pid, signal.SIGKILL)
            readers = ([master] if output_open else []) + ([0] if stopping is None else [])
            readable, _, _ = select.select(readers, [], [], 0.05)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    print(json.dumps({"stream": "stdout", "delta": base64.b64encode(data).decode("ascii")}), flush=True)
                else:
                    output_open = False
            if 0 in readable:
                data = os.read(0, 65536)
                if not data:
                    stop()
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
                        stop()
        assert status is not None
        code = os.waitstatus_to_exitcode(status)
        return code if code >= 0 else 128 - code
    finally:
        kill_group(pid, signal.SIGKILL)
        if status is None:
            os.waitpid(pid, 0)
        os.close(master)


if __name__ == "__main__":
    sys.exit(main())
