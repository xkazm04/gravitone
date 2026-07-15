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

import os
from pathlib import Path


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
