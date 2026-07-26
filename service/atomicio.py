"""Atomic file writes.

Write to a per-process temp file in the same directory, then ``os.replace`` it
onto the target. ``os.replace`` is atomic on POSIX and Windows, so a reader (or
a concurrent replica process) never observes a torn/partial file — the target
always contains either the complete old contents or the complete new contents.
This is the durability primitive the single-JSON-file stores rely on
(``api_keys.json``, ``emotion_demand.json``): an interrupted or interleaved
write can no longer truncate them.
"""
from __future__ import annotations

import contextlib
import logging
import os
import time
from pathlib import Path

logger = logging.getLogger("gravitone")

# Cross-process mutex defaults. Registry mutations are short (a JSON load, an
# in-memory edit, an atomic save), so a caller waiting seconds means something
# is genuinely stuck rather than merely contended.
LOCK_TIMEOUT_S = 10.0
LOCK_STALE_S = 60.0
_LOCK_POLL_S = 0.02


@contextlib.contextmanager
def file_lock(path: Path, timeout: float = LOCK_TIMEOUT_S,
              stale_after: float = LOCK_STALE_S):
    """Cross-PROCESS mutual exclusion around a read-modify-write.

    `os.open(O_CREAT|O_EXCL)` is an atomic create-if-absent — the same
    primitive `takes.py` uses for its first-pick-wins `.pick` sentinel,
    generalized here into a waiting lock. This is what a `threading.Lock`
    cannot give us: the service is deployed as N single-worker processes
    (`service/replicas.py`), where an in-process lock serializes nothing
    between replicas and two concurrent read-modify-writes silently drop one
    another's changes (`os.replace` prevents torn files, not lost updates).

    A holder killed by SIGKILL leaves the lock file behind, so a lock older
    than `stale_after` is broken and reclaimed. Raises `TimeoutError` rather
    than proceeding unlocked: losing a registry update silently is worse than
    failing the request loudly.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    fd = None
    while True:
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                age = time.time() - path.stat().st_mtime
            except OSError:
                age = 0.0  # vanished between the open and the stat — retry
            if age > stale_after:
                logger.warning("breaking stale lock %s (held %.0fs)", path, age)
                with contextlib.suppress(OSError):
                    path.unlink()
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"could not acquire {path.name} within {timeout:.0f}s")
            time.sleep(_LOCK_POLL_S)
    try:
        with contextlib.suppress(OSError):
            os.write(fd, f"{os.getpid()}".encode())
        yield
    finally:
        with contextlib.suppress(OSError):
            os.close(fd)
        with contextlib.suppress(OSError):
            path.unlink()


def atomic_write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique temp per process so two replicas writing concurrently don't clobber
    # each other's temp before the rename.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding)
        os.replace(tmp, path)
    finally:
        # os.replace consumed tmp on success; clean it up only if it survived
        # (write or replace failed partway).
        if tmp.exists():
            tmp.unlink(missing_ok=True)
