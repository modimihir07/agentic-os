"""Shared re-entrant interprocess lock for Hermes profile mutations."""
from __future__ import annotations

import fcntl
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

_STATE = threading.local()


def _lock_root() -> Path:
    configured = os.getenv("AGENTIC_OS_HERMES_HOME") or os.getenv("HERMES_HOME")
    return Path(configured or str(Path.home() / ".hermes"))


@contextmanager
def profile_process_lock() -> Iterator[None]:
    """Serialize profile mutations across workers and allow same-thread nesting."""
    depth = int(getattr(_STATE, "depth", 0))
    if depth:
        _STATE.depth = depth + 1
        try:
            yield
        finally:
            _STATE.depth -= 1
        return

    root = _lock_root()
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink() or not root.is_dir():
        raise OSError("Unsafe Hermes root for profile lock")
    lock_path = root / ".agent-playground.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        _STATE.depth = 1
        yield
    finally:
        _STATE.depth = 0
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
