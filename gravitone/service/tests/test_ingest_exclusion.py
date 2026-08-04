"""One box, many processes, one truth per ingest job.

The service ships as N single-worker processes (`service/replicas.py`) pointed
at ONE `INGEST_WORK_DIR`. Everything here is about what that means and what the
module used to get wrong:

  * `_persist` wrote through a FIXED temp name, so two replicas mirroring the
    same job interleaved into one temp and `os.replace` could promote a mixed
    file. `atomicio` has had a per-process temp name and a cross-process mutex
    the whole time.
  * `_rehydrate` loaded EVERY `state.json` under the root into EVERY process,
    so one job ended up with N owners, N sets of phase threads and N GC
    verdicts.
  * `_gc_once` reaped directories a sibling replica was still writing into.
  * admission counted per process while the 429 quoted the single configured
    number.
  * `restem` read the status unlocked and then spliced, while `commit` flipped
    that status and handed the same file to the export child.

The first three cases therefore spawn REAL PROCESSES (the `test_file_lock` /
`test_telemetry_exclusion` pattern). A threading test would pass against the
bug, because a `threading.Lock` is exactly what was already there.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi import HTTPException

from service import ingest_api

REPO_ROOT = Path(__file__).resolve().parents[2]


def _run_children(source: str, params: list[dict], timeout: float = 180.0
                  ) -> list[str]:
    """Run one child process per `params` entry, concurrently, and return their
    stdout. A non-zero exit is an assertion failure with the child's stderr."""
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT)
    running = [
        subprocess.Popen(
            [sys.executable, "-c", source % {"root": str(REPO_ROOT), **p}],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
            cwd=str(REPO_ROOT), text=True)
        for p in params
    ]
    out: list[str] = []
    for p in running:
        stdout, stderr = p.communicate(timeout=timeout)
        if p.returncode != 0:
            raise AssertionError(f"child failed: {stderr}")
        out.append(stdout)
    return out


_PERSIST_CHILD = """
import sys
sys.path.insert(0, %(root)r)
from pathlib import Path
import service.ingest_api as ia
wd = Path(%(wd)r)
job = {"id": "j", "work_dir": str(wd), "status": "running",
       "who": %(who)r, "blob": %(who)r * 300000}
for _ in range(%(n)d):
    ia._persist(job)
"""

_REHYDRATE_CHILD = """
import json, sys, time
sys.path.insert(0, %(root)r)
from pathlib import Path
import service.ingest_api as ia
ia.WORK_ROOT = Path(%(root_dir)r)
ia._beat()
time.sleep(%(delay)f)      # both beats are on disk before either claims
ia._rehydrate()
print(json.dumps(sorted(ia.JOBS)))
sys.stdout.flush()
time.sleep(2.0)            # stay "alive" while the sibling decides
"""


def _job(wd: Path, jid: str = "j", status: str = "done") -> dict:
    wd.mkdir(parents=True, exist_ok=True)
    return {"id": jid, "status": status, "step": None, "mode": "sovereign",
            "steps": [], "partial": {}, "speakers": None, "duration": 0,
            "result": None, "error": None, "work_dir": str(wd),
            "created": time.time(), "clip_sha256": "abc", "cancel": False,
            "committed": None}


class PersistIsCrossProcessSafeTests(unittest.TestCase):
    def test_a_held_lock_holds_the_write(self) -> None:
        """The proof that `_persist` takes the CROSS-PROCESS mutex at all.

        Delete `atomicio.file_lock` from `_persist` and this fails: the write
        lands immediately, which is precisely the behaviour that let two
        replicas interleave.
        """
        with TemporaryDirectory() as td:
            wd = Path(td) / "j"
            job = _job(wd)
            lock = wd / ".state.lock"
            # "Another replica" holds it.
            os.close(os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            done = threading.Event()

            def _call() -> None:
                ingest_api._persist(job)
                done.set()

            threading.Thread(target=_call, daemon=True).start()
            self.assertFalse(done.wait(0.5))
            self.assertFalse((wd / "state.json").exists(),
                             "_persist wrote while another process held the lock")
            lock.unlink()
            self.assertTrue(done.wait(15), "_persist never returned")
            self.assertTrue((wd / "state.json").exists())

    def test_the_lock_does_not_outlive_the_write(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td) / "j"
            ingest_api._persist(_job(wd))
            self.assertFalse((wd / ".state.lock").exists())

    def test_the_write_itself_is_the_atomic_one(self) -> None:
        """`atomicio.atomic_write_text` names its temp file per PROCESS. The
        old inline `state.json.tmp` write did not, which is the collision two
        replicas actually hit — so the mechanism, not just the outcome, is
        asserted here (an outcome-only test is a coin flip on a fast disk)."""
        with TemporaryDirectory() as td:
            wd = Path(td) / "j"
            job = _job(wd)
            with mock.patch.object(ingest_api.atomicio, "atomic_write_text") as w:
                ingest_api._persist(job)
            w.assert_called_once()
            self.assertEqual(w.call_args.args[0], wd / "state.json")

    def test_no_fixed_temp_file_survives(self) -> None:
        # The old writer's `state.json.tmp` is the shared name two processes
        # used to collide on. Nothing may be left behind at all.
        with TemporaryDirectory() as td:
            wd = Path(td) / "j"
            ingest_api._persist(_job(wd))
            leftovers = [p.name for p in wd.iterdir() if p.name.endswith(".tmp")]
            self.assertEqual(leftovers, [])

    def test_three_replicas_never_promote_a_torn_state_file(self) -> None:
        """Real processes, one job directory, a reader watching the whole time.

        With the fixed temp name this fails with a JSONDecodeError (or a state
        file carrying two writers' bytes); with a per-process temp under the
        file lock every observation is one writer's complete document.
        """
        with TemporaryDirectory() as td:
            wd = Path(td) / "j"
            wd.mkdir(parents=True)
            state = wd / "state.json"
            stop = threading.Event()
            bad: list[str] = []

            def _watch() -> None:
                while not stop.is_set():
                    try:
                        raw = state.read_text("utf-8")
                    except OSError:
                        continue
                    if not raw:
                        continue
                    try:
                        doc = json.loads(raw)
                    except json.JSONDecodeError:
                        bad.append(raw[:120])
                        continue
                    if doc.get("blob", "")[:1] != doc.get("who"):
                        bad.append("mixed writers in one document")

            watcher = threading.Thread(target=_watch, daemon=True)
            watcher.start()
            try:
                _run_children(_PERSIST_CHILD,
                              [{"wd": str(wd), "who": who, "n": 40}
                               for who in ("a", "b", "c")])
            finally:
                stop.set()
                watcher.join(timeout=5)
            self.assertEqual(bad, [], f"torn state.json observed: {bad[:3]}")
            json.loads(state.read_text("utf-8"))   # and it ends valid


class OwnershipTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig)

    def test_two_processes_rehydrating_one_root_yield_one_owner(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            job = _job(root / "shared", "shared")
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._persist(job)
            (root / "shared" / "owner.json").unlink(missing_ok=True)
            outs = _run_children(
                _REHYDRATE_CHILD,
                [{"root_dir": str(root), "delay": 0.6} for _ in range(2)])
            claimed = [jid for out in outs
                       for jid in json.loads(out.strip().splitlines()[-1])]
            self.assertEqual(claimed, ["shared"],
                             "exactly one process may own a job")

    def test_a_live_owner_keeps_its_job(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            wd = root / "theirs"
            job = _job(wd, "theirs")
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._persist(job)
                _their_owner(root, wd, alive=True)
                ingest_api._rehydrate()
                self.assertNotIn("theirs", ingest_api.JOBS)
                self.assertEqual(ingest_api._owner_of(wd), "other-replica")

    def test_a_dead_owners_job_is_adopted(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            wd = root / "orphan"
            job = _job(wd, "orphan")
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._persist(job)
                _their_owner(root, wd, alive=False)
                ingest_api._rehydrate()
                self.assertIn("orphan", ingest_api.JOBS)
                self.assertEqual(ingest_api._owner_of(wd), ingest_api.OWNER)

    def test_gc_will_not_reap_a_live_siblings_workdir(self) -> None:
        # The documented-as-unfixed bug: an orphan sweep that only knows about
        # THIS process's JOBS deleted another replica's live workdir.
        with TemporaryDirectory() as td:
            root = Path(td)
            wd = root / "theirs"
            wd.mkdir()
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                _their_owner(root, wd, alive=True)
                _age(wd)
                ingest_api._gc_once()
                self.assertTrue(wd.is_dir(), "GC reaped a live replica's job")
                # ...and once that replica stops beating, it IS reaped.
                (root / ".owners" / "other-replica.alive").unlink()
                ingest_api._gc_once()
                self.assertFalse(wd.exists())

    def test_the_owners_directory_is_not_mistaken_for_a_job(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._beat()
                _age(root / ".owners")
                ingest_api._gc_once()
                self.assertTrue(ingest_api._beat_path().is_file(),
                                "GC swept this process's own heartbeat")
                ingest_api._rehydrate()
                self.assertEqual(ingest_api.JOBS, {})

    def test_a_clean_shutdown_releases_ownership_immediately(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._beat()
                self.assertTrue(ingest_api._owner_alive(ingest_api.OWNER))
                ingest_api._release_owner()
                self.assertFalse(ingest_api._beat_path().exists())


def _their_owner(root: Path, wd: Path, *, alive: bool) -> None:
    """Make `wd` look owned by another replica, beating or not."""
    (wd / "owner.json").write_text(
        json.dumps({"owner": "other-replica", "pid": 999,
                    "claimed_at": time.time()}), "utf-8")
    beat = root / ".owners" / "other-replica.alive"
    beat.parent.mkdir(parents=True, exist_ok=True)
    beat.write_text("x", "utf-8")
    if not alive:
        old = time.time() - ingest_api._OWNER_STALE_S - 30
        os.utime(beat, (old, old))


def _age(path: Path) -> None:
    old = time.time() - ingest_api._TTL - 60
    os.utime(path, (old, old))


class HonestAdmissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()
        self._replicas = os.environ.get("TTS_REPLICAS")

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig)
        if self._replicas is None:
            os.environ.pop("TTS_REPLICAS", None)
        else:
            os.environ["TTS_REPLICAS"] = self._replicas

    def test_a_single_process_still_gets_the_whole_budget(self) -> None:
        os.environ["TTS_REPLICAS"] = "1"
        self.assertEqual(ingest_api.admission_shape(4), (4, 4, 1))

    def test_the_budget_is_divided_across_replicas(self) -> None:
        os.environ["TTS_REPLICAS"] = "4"
        self.assertEqual(ingest_api.admission_shape(8), (2, 8, 4))

    def test_a_budget_smaller_than_the_pool_floors_at_one_per_replica(self) -> None:
        os.environ["TTS_REPLICAS"] = "4"
        self.assertEqual(ingest_api.admission_shape(2), (1, 4, 4))

    def test_a_disabled_budget_stays_disabled(self) -> None:
        # Flooring the share at 1 must not hand back a surface an operator
        # switched off with a zero.
        os.environ["TTS_REPLICAS"] = "4"
        self.assertEqual(ingest_api.admission_shape(0), (0, 0, 4))

    def test_the_429_states_the_pool_wide_number(self) -> None:
        os.environ["TTS_REPLICAS"] = "4"
        with TemporaryDirectory() as td:
            ingest_api.JOBS["busy"] = _job(Path(td) / "busy", "busy", "running")
            with mock.patch.object(ingest_api, "MAX_ACTIVE_JOBS", 4):
                with self.assertRaises(HTTPException) as ctx:
                    ingest_api._admit()
            detail = ctx.exception.detail
            self.assertEqual(ctx.exception.status_code, 429)
            self.assertIn("4 replica", detail.replace("runs 4 of them", "4 replicas"))
            self.assertIn("at most 4", detail)

    def test_one_replica_is_not_told_about_replicas(self) -> None:
        os.environ["TTS_REPLICAS"] = "1"
        with TemporaryDirectory() as td:
            ingest_api.JOBS["busy"] = _job(Path(td) / "busy", "busy", "running")
            with mock.patch.object(ingest_api, "MAX_ACTIVE_JOBS", 1):
                with self.assertRaises(HTTPException) as ctx:
                    ingest_api._admit()
            self.assertNotIn("replica", ctx.exception.detail)

    def test_auditions_are_divided_too(self) -> None:
        os.environ["TTS_REPLICAS"] = "2"
        with mock.patch.object(ingest_api, "MAX_ACTIVE_AUDITIONS", 2), \
             mock.patch.object(ingest_api, "_active_auditions", 1):
            with self.assertRaises(HTTPException) as ctx:
                with ingest_api._audition_slot():
                    pass
        self.assertIn("at most 2", ctx.exception.detail)


class RestemCommitRaceTests(unittest.TestCase):
    """A /stems call that passed its status check must not rewrite the stem a
    commit is already cloning."""

    def setUp(self) -> None:
        self._orig = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig)

    def _scan(self, root: Path) -> dict:
        job = _job(root / "s1", "s1", "done")
        job["result"] = {"stems": [{"emotion": "happy", "seconds": 6.0,
                                    "segments": 2, "eligible": True}],
                         "segments": [{"emotion": "happy"}, {"emotion": "happy"}],
                         "min_stem": 4.0}
        wd = Path(job["work_dir"])
        for i in range(2):
            (wd / f"seg_{i:03d}.wav").write_bytes(b"RIFF")
        ingest_api.JOBS["s1"] = job
        return job

    def test_a_commit_landing_mid_restem_refuses_the_restem(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            job = self._scan(root)
            wd = Path(job["work_dir"])
            rows = [{"i": i, "wav": str(wd / f"seg_{i:03d}.wav"),
                     "emotion": "happy", "confidence": 1.0, "seconds": 3.0}
                    for i in range(2)]

            def _flip_then_board(work_dir, result):
                # The commit lands in the window between the cheap check and
                # the splice — exactly where the old code had no re-check.
                job["status"] = "committing"
                return rows, {"happy": [0, 1]}, None

            spliced: list = []
            with mock.patch.object(ingest_api, "_board", _flip_then_board), \
                 mock.patch.object(ingest_api.ingest, "concat_wavs",
                                   side_effect=lambda *a, **k: spliced.append(a)):
                with self.assertRaises(HTTPException) as ctx:
                    ingest_api.restem(
                        "s1", ingest_api.StemsReq(assignments={"happy": [0]}))
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertEqual(spliced, [],
                             "a committing job's stem was re-spliced anyway")

    def test_a_commit_cannot_flip_while_a_restem_holds_the_stem_lock(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            job = self._scan(root)
            req = ingest_api.CommitReq(character="Ada", emotions=["happy"],
                                       attested=True, statement="I own it.")
            with mock.patch.object(ingest_api, "_do_commit", lambda *a, **k: None):
                ingest_api._STEM_LOCK.acquire()
                try:
                    t = threading.Thread(
                        target=lambda: ingest_api.commit("s1", req), daemon=True)
                    t.start()
                    time.sleep(0.4)
                    self.assertEqual(job["status"], "done",
                                     "commit flipped the status under a re-splice")
                finally:
                    ingest_api._STEM_LOCK.release()
                t.join(timeout=10)
            self.assertEqual(job["status"], "committing")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
