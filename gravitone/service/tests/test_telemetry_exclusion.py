"""The cross-process law applies to telemetry too.

`direction.py` and `demand.py` guard a read-modify-write of a shared JSON file.
Both used a bare `threading.Lock`, which serializes one process against itself
and NOTHING against the other replicas the service ships as. `os.replace`
prevents a torn file, not a lost update: two replicas that each read, each add
and each write leave one replica's whole contribution on the floor — on files
described as a training corpus and as the recording queue's evidence.

So these cases spawn REAL processes (the `test_file_lock` pattern). A threading
test would pass against the bug.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from service import demand as demand_mod
from service import direction as direction_mod

REPO_ROOT = Path(__file__).resolve().parents[2]

_DEMAND_CHILD = """
import sys
sys.path.insert(0, %(root)r)
from pathlib import Path
import service.demand as demand
demand.DEMAND_PATH = Path(%(path)r)
for _ in range(%(n)d):
    demand.record_fallback("sarah", "angry")
"""

_DIRECTION_CHILD = """
import sys
sys.path.insert(0, %(root)r)
from pathlib import Path
import service.direction as direction
direction.DIRECTION_PATH = Path(%(path)r)
parent = {"character_id": "sarah",
          "segments": [{"requested": "baseline"}]}
child = {"character_id": "sarah", "segments": [{"requested": "angry"}]}
for _ in range(%(n)d):
    direction.record_delta(parent, child)
"""


def _run(source: str, path: Path, n: int, procs: int) -> None:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT)
    running = [
        subprocess.Popen(
            [sys.executable, "-c", source % {"root": str(REPO_ROOT),
                                             "path": str(path), "n": n}],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
            cwd=str(REPO_ROOT), text=True)
        for _ in range(procs)
    ]
    for p in running:
        _, stderr = p.communicate(timeout=180)
        if p.returncode != 0:
            raise AssertionError(f"child failed: {stderr}")


def demand_lock(path: Path) -> Path:
    """What `_lock_path()` derives, spelled out independently so a test does
    not agree with the code by construction."""
    return path.with_name("." + path.name + ".lock")


class DemandAcrossProcessesTests(unittest.TestCase):
    def test_three_replicas_lose_no_counts(self) -> None:
        with TemporaryDirectory() as td:
            path = Path(td) / "emotion_demand.json"
            _run(_DEMAND_CHILD, path, n=30, procs=3)
            data = json.loads(path.read_text("utf-8"))
            # Bare threading.Lock: whole windows of increments vanish here.
            self.assertEqual(data["sarah"]["angry"], 90)

    def test_the_lock_file_does_not_outlive_the_write(self) -> None:
        with TemporaryDirectory() as td:
            path = Path(td) / "emotion_demand.json"
            _run(_DEMAND_CHILD, path, n=1, procs=1)
            self.assertFalse(demand_lock(path).exists())


class DirectionAcrossProcessesTests(unittest.TestCase):
    def test_three_replicas_lose_no_deltas(self) -> None:
        with TemporaryDirectory() as td:
            path = Path(td) / "direction_deltas.json"
            _run(_DIRECTION_CHILD, path, n=20, procs=3)
            data = json.loads(path.read_text("utf-8"))
            entry = data["characters"]["sarah"]
            self.assertEqual(entry["children"], 60)
            self.assertEqual(entry["deltas"]["baseline>angry"], 60)


class LockPathTests(unittest.TestCase):
    """The mutex must follow the store it guards — both are redirected by
    deployments and by tests, and a lock left pointing at the old path guards
    nothing."""

    def test_direction_lock_follows_a_redirected_store(self) -> None:
        original = direction_mod.DIRECTION_PATH
        try:
            direction_mod.DIRECTION_PATH = Path("/tmp/elsewhere/d.json")
            self.assertEqual(direction_mod._lock_path(),
                             Path("/tmp/elsewhere/.d.json.lock"))
        finally:
            direction_mod.DIRECTION_PATH = original

    def test_demand_lock_follows_a_redirected_store(self) -> None:
        original = demand_mod.DEMAND_PATH
        try:
            demand_mod.DEMAND_PATH = Path("/tmp/elsewhere/e.json")
            self.assertEqual(demand_mod._lock_path(),
                             Path("/tmp/elsewhere/.e.json.lock"))
        finally:
            demand_mod.DEMAND_PATH = original


class TelemetryStillNeverRaisesTests(unittest.TestCase):
    """A wedged lock must cost a statistic, never a render."""

    def test_demand_swallows_a_lock_timeout(self) -> None:
        with TemporaryDirectory() as td:
            path = Path(td) / "emotion_demand.json"
            original = demand_mod.DEMAND_PATH
            demand_mod.DEMAND_PATH = path
            try:
                # Hold the lock from "another replica" and never let go.
                held = demand_lock(path)
                held.parent.mkdir(parents=True, exist_ok=True)
                os.close(os.open(str(held), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                done = threading.Event()

                def _call() -> None:
                    demand_mod.record_fallback("sarah", "angry")
                    done.set()

                t = threading.Thread(target=_call, daemon=True)
                t.start()
                # atomicio's default timeout is 10s; the point is that it
                # RETURNS rather than raising into the caller's render.
                self.assertTrue(done.wait(30), "record_fallback never returned")
                self.assertFalse(path.exists(), "nothing should have been written")
            finally:
                demand_mod.DEMAND_PATH = original

    def test_direction_swallows_a_lock_timeout(self) -> None:
        with TemporaryDirectory() as td:
            path = Path(td) / "direction_deltas.json"
            original = direction_mod.DIRECTION_PATH
            direction_mod.DIRECTION_PATH = path
            try:
                held = demand_lock(path)
                held.parent.mkdir(parents=True, exist_ok=True)
                os.close(os.open(str(held), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                direction_mod.record_delta(
                    {"character_id": "sarah", "segments": [{"requested": "baseline"}]},
                    {"character_id": "sarah", "segments": [{"requested": "angry"}]})
                self.assertFalse(path.exists())
            finally:
                direction_mod.DIRECTION_PATH = original


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
