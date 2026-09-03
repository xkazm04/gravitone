"""The shared job registry — the contract that lets two modules keep one copy.

`service/jobs.py` supplies the behaviour; the pipeline module supplies the
state. Everything here pins that seam, because it is the part a future edit can
break silently: a registry that cached `JOBS` or `_ADMIT` in itself would pass
every existing test that only drives one module end to end, and then quietly
ignore a deployment's repointed WORK_DIR and every `mock.patch.object` in the
suite.
"""
from __future__ import annotations

import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from service.tests import fake_engine  # installs shims — must precede app import

import service.jobs as jobs
import service.revoice_api as revoice_api
import service.voiceover_api as voiceover_api


def _fake_module(root: Path) -> types.ModuleType:
    """A minimal pipeline module: nothing but the state a registry reads."""
    mod = types.ModuleType("service.tests._fake_pipeline")
    mod.JOBS = {}
    mod._LOCK = threading.Lock()
    mod._REAP = []
    mod._ADMIT = threading.BoundedSemaphore(1)
    mod.WORK_DIR = root
    mod.STEPS = (("one", "the first"), ("two", "the second"))
    mod._PUBLIC_KEYS = ("id", "status", "step", "steps", "partial")
    mod._TTL_S = 30 * 60
    mod._RUNNING_TTL_S = 120 * 60
    mod._REAP_GRACE_S = 60
    import sys
    sys.modules[mod.__name__] = mod
    return mod


class RegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.mod = _fake_module(Path(self._td.name))
        self.addCleanup(self._td.cleanup)
        self.reg = jobs.JobRegistry(self.mod.__name__)

    def _job(self, **fields) -> dict:
        # Exactly the door's order: take the permit, THEN mint the job that
        # holds it. `permit=True` on a job that never acquired one would
        # over-release a BoundedSemaphore, which is the point of the flag.
        self.assertTrue(self.reg.acquire_admission())
        return self.reg.new_job(permit=True, source={"kind": "test"}, **fields)

    def test_a_new_job_is_registered_with_its_steps_and_work_dir(self) -> None:
        job = self._job()
        self.assertIn(job["id"], self.mod.JOBS)
        self.assertEqual(job["step"], "one")
        self.assertEqual([s["key"] for s in job["steps"]], ["one", "two"])
        self.assertTrue(Path(job["work_dir"]).is_dir())
        self.assertEqual(job["source"], {"kind": "test"})

    def test_a_job_leaves_running_exactly_once(self) -> None:
        job = self._job()
        self.reg.finish(job, "cancelled")
        self.reg.finish(job, "done", result={"never": True})
        self.assertEqual(job["status"], "cancelled")
        self.assertIsNone(job["result"])

    def test_the_permit_comes_back_at_most_once(self) -> None:
        job = self._job()
        self.reg.release_admission(job)
        self.reg.release_admission(job)  # a no-op, not a boom
        self.assertTrue(self.reg.acquire_admission())
        self.assertFalse(self.reg.acquire_admission())

    def test_a_work_dir_is_reaped_only_after_the_grace(self) -> None:
        job = self._job()
        wd = Path(job["work_dir"])
        self.reg.finish(job, "done")
        job["touched"] = time.time() - self.mod._TTL_S - 1
        self.reg.gc()
        self.assertNotIn(job["id"], self.mod.JOBS)
        self.assertTrue(wd.is_dir(), "a streaming download must not be yanked")
        self.mod._REAP[:] = [(0.0, str(wd))]
        self.reg.gc()
        self.assertFalse(wd.exists())

    def test_abandoning_at_the_door_skips_the_grace(self) -> None:
        # The id was never handed to a client, so nothing can be reading it.
        job = self._job()
        wd = Path(job["work_dir"])
        self.reg.abandon_at_the_door(job)
        self.assertNotIn(job["id"], self.mod.JOBS)
        self.assertFalse(wd.exists())
        self.assertEqual(self.mod._REAP, [])
        self.assertTrue(self.reg.acquire_admission())

    def test_a_failure_before_the_job_exists_still_returns_the_permit(self) -> None:
        self.assertTrue(self.reg.acquire_admission())
        self.reg.abandon_at_the_door(None)
        self.assertTrue(self.reg.acquire_admission())

    def test_public_is_exactly_the_modules_key_list(self) -> None:
        job = self._job()
        self.assertEqual(set(self.reg.public(job)), set(self.mod._PUBLIC_KEYS))


class LiveModuleStateTests(unittest.TestCase):
    """The registry reads its state off the module EVERY TIME.

    If any of these fail, someone cached module state in the registry and a
    deployment's repointed WORK_DIR (or any patch in the two suites) is being
    silently ignored.
    """

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.mod = _fake_module(Path(self._td.name))
        self.addCleanup(self._td.cleanup)
        self.reg = jobs.JobRegistry(self.mod.__name__)

    def test_a_repointed_work_dir_is_honoured(self) -> None:
        with tempfile.TemporaryDirectory() as other:
            with mock.patch.object(self.mod, "WORK_DIR", Path(other)):
                job = self.reg.new_job(source={})
            self.assertTrue(Path(job["work_dir"]).is_relative_to(Path(other)))

    def test_a_patched_semaphore_is_the_one_that_admits(self) -> None:
        with mock.patch.object(self.mod, "_ADMIT",
                               threading.BoundedSemaphore(2)):
            self.assertTrue(self.reg.acquire_admission())
            self.assertTrue(self.reg.acquire_admission())
            self.assertFalse(self.reg.acquire_admission())
        # ...and the module's real permit was never spent.
        self.assertTrue(self.reg.acquire_admission())

    def test_a_patched_reap_list_is_the_one_that_fills(self) -> None:
        with mock.patch.object(self.mod, "_REAP", []) as _:
            self.reg.schedule_reap("somewhere")
            self.assertEqual(len(self.mod._REAP), 1)

    def test_a_patched_steps_tuple_shapes_the_next_job(self) -> None:
        with mock.patch.object(self.mod, "STEPS", (("only", "the only one"),)):
            job = self.reg.new_job(source={})
        self.assertEqual([s["key"] for s in job["steps"]], ["only"])


class BothPipelinesShareOneRegistryTests(unittest.TestCase):
    """One class, two instances, two separate namespaces of state."""

    def test_the_module_aliases_are_the_registrys_methods(self) -> None:
        for mod in (voiceover_api, revoice_api):
            with self.subTest(module=mod.__name__):
                for name, method in (
                    ("_get", "get"), ("_public", "public"),
                    ("_update", "update"), ("_step", "step"),
                    ("_partial", "partial"), ("_finish", "finish"),
                    ("_schedule_reap", "schedule_reap"), ("_gc", "gc"),
                    ("_acquire_admission", "acquire_admission"),
                    ("_release_admission", "release_admission"),
                    ("_abandon_at_the_door", "abandon_at_the_door"),
                    ("_artifact", "artifact"),
                ):
                    self.assertIs(getattr(mod, name).__func__,
                                  getattr(jobs.JobRegistry, method),
                                  f"{mod.__name__}.{name}")

    def test_the_two_registries_do_not_share_state(self) -> None:
        self.assertIsNot(voiceover_api.JOBS, revoice_api.JOBS)
        self.assertIsNot(voiceover_api._ADMIT, revoice_api._ADMIT)
        self.assertIsNot(voiceover_api._REGISTRY, revoice_api._REGISTRY)
        self.assertIs(voiceover_api._REGISTRY.jobs, voiceover_api.JOBS)
        self.assertIs(revoice_api._REGISTRY.jobs, revoice_api.JOBS)

    def test_each_pipeline_keeps_its_own_phases(self) -> None:
        # The thing the registry must NOT have absorbed.
        self.assertIsNot(voiceover_api._run_job, revoice_api._run_job)
        self.assertNotEqual([k for k, _ in voiceover_api.STEPS],
                            [k for k, _ in revoice_api.STEPS])


if __name__ == "__main__":
    unittest.main()
