"""The job registry the two video pipelines share — bookkeeping only.

`voiceover_api` and `revoice_api` run the same SHAPE of job: a door that takes
a permit, one phase thread walking a fixed list of steps, a per-process
registry with a TTL, and a deferred reaper for the work dir. That shape was
written twice and the copies drifted, so it lives here once.

WHAT LIVES HERE: reading and mutating a job dict under the lock, the TTL sweep,
the reap queue, the admission permit, and the artifact route's "expired / not
ready / here it is". All of it was identical between the two pipelines because
none of it knows what a pipeline DOES.

WHAT DOES NOT: `_run_job`, and the doors. Six steps against four, a cloud
vision pass against a per-line fit ladder — folding those into one template
would produce exactly the coupling the modules were right to avoid. Each keeps
its own runner and its own authored failures.

THE MODULE IS THE CONFIGURATION SURFACE. A registry never copies ``JOBS``,
``_LOCK``, ``_REAP``, ``_ADMIT``, ``WORK_DIR``, ``STEPS`` or the TTLs into
itself; it reads them off its module every time, by name. Those names are what
a deployment repoints and what a test patches
(``mock.patch.object(revoice_api, "_ADMIT", ...)``), and a registry holding a
private reference would quietly ignore both.
"""
from __future__ import annotations

import shutil
import sys
import threading
import time
import uuid
from pathlib import Path

from fastapi.responses import FileResponse, JSONResponse

from service import errors


class JobRegistry:
    """One pipeline's job bookkeeping, bound to the module that owns its state.

    Instantiated once per module with nothing but its own name; everything else
    is read live off that module. Two callers, one registry — this is not a job
    framework and must not grow into one.
    """

    __slots__ = ("_module",)

    def __init__(self, module: str) -> None:
        self._module = module

    # ── the module's state, read live ────────────────────────────────────
    @property
    def module(self):
        return sys.modules[self._module]

    @property
    def jobs(self) -> dict:
        return self.module.JOBS

    @property
    def lock(self) -> threading.Lock:
        return self.module._LOCK

    @property
    def reap(self) -> list:
        return self.module._REAP

    @property
    def admit(self) -> threading.BoundedSemaphore:
        return self.module._ADMIT

    # ── minting ──────────────────────────────────────────────────────────
    def new_job(self, *, permit: bool = False, **fields) -> dict:
        """A registered job with its work dir on disk. The skeleton is the same
        in both pipelines; ``fields`` is what that pipeline additionally carries
        — a character and a style, or the lines and their options."""
        job_id = uuid.uuid4().hex[:12]
        steps = self.module.STEPS
        wd = self.module.WORK_DIR / job_id
        wd.mkdir(parents=True, exist_ok=True)
        job = {"id": job_id, "status": "running", "step": steps[0][0],
               "steps": [{"key": k, "label": l, "state": "pending"}
                         for k, l in steps],
               "partial": {}, "error": None, "brain": None, "result": None,
               "work_dir": str(wd), "cancel": False, "permit": bool(permit),
               "created": time.time(), "touched": time.time()}
        job.update(fields)
        with self.lock:
            self.jobs[job_id] = job
        return job

    # ── reading ──────────────────────────────────────────────────────────
    def get(self, job_id: str) -> dict | None:
        self.gc()
        with self.lock:
            job = self.jobs.get(job_id)
            if job is not None:
                job["touched"] = time.time()
            return job

    def public(self, job: dict) -> dict:
        return {k: job.get(k) for k in self.module._PUBLIC_KEYS}

    # ── mutation, always under the lock ──────────────────────────────────
    def update(self, job: dict, **fields) -> None:
        with self.lock:
            job.update(fields)
            job["touched"] = time.time()

    def step(self, job: dict, key: str, state: str) -> None:
        with self.lock:
            for s in job["steps"]:
                if s["key"] == key:
                    s["state"] = state
            if state == "active":
                job["step"] = key

    def partial(self, job: dict, d: dict) -> None:
        with self.lock:
            job["partial"].update(d)

    def finish(self, job: dict, status: str, **fields) -> None:
        """Write a job's ONE terminal state — first writer wins.

        ``cancel()`` may flip a running job to ``cancelled`` while the phase
        thread is mid-step; that thread then finishes its step and would stamp
        ``done`` over the top, so a job could report two terminal states
        depending on who read it when. A job leaves ``running`` exactly once.
        """
        with self.lock:
            if job["status"] != "running":
                return
            job.update(fields)
            job["status"] = status
            job["touched"] = time.time()

    # ── reclamation ──────────────────────────────────────────────────────
    def schedule_reap(self, work_dir: str) -> None:
        """Hand a work dir to ``gc``, the grace period from now. Callers hold
        the lock."""
        self.reap.append((time.time() + self.module._REAP_GRACE_S, work_dir))

    def gc(self) -> None:
        now = time.time()
        with self.lock:
            ttl = self.module._TTL_S
            running_ttl = self.module._RUNNING_TTL_S
            for job in list(self.jobs.values()):
                idle = now - job["touched"]
                age = now - job["created"]
                done = job["status"] in ("done", "error", "cancelled")
                # `touched` keeps a watched job alive; `created` bounds a
                # wedged run even when a poller keeps touching it — a job that
                # has been "running" for two hours is not going to finish.
                if (done and idle > ttl) or age > running_ttl:
                    self.schedule_reap(self.jobs.pop(job["id"])["work_dir"])
            due = [w for deadline, w in self.reap if deadline <= now]
            self.reap[:] = [(d, w) for d, w in self.reap if d > now]
        for work_dir in due:
            shutil.rmtree(work_dir, ignore_errors=True)

    # ── admission ────────────────────────────────────────────────────────
    def acquire_admission(self) -> bool:
        return self.admit.acquire(blocking=False)

    def release_admission(self, job: dict) -> None:
        """Hand back this job's permit, at most once.

        Idempotent by construction: the flag is popped under the lock, so two
        callers racing (a door that failed to start its thread, the worker's
        ``finally``) cannot double-release a BoundedSemaphore.
        """
        with self.lock:
            held = bool(job.pop("permit", False))
        if held:
            self.admit.release()

    def abandon_at_the_door(self, job: dict | None) -> None:
        """Undo a job the door built but never handed to a phase thread.

        No ``_run_job`` will ever run its ``finally`` for it, so the door is the
        only one left who can give the permit back. ``job is None`` means the
        failure beat ``new_job`` and the permit is the only thing to return.
        This is also the ONE deletion that skips the reap grace: the job id was
        never returned to any client, so no ``FileResponse`` can be streaming
        out of that dir.
        """
        if job is None:
            self.admit.release()
            return
        with self.lock:
            self.jobs.pop(job["id"], None)
        self.release_admission(job)
        shutil.rmtree(job["work_dir"], ignore_errors=True)

    # ── the artifact route ───────────────────────────────────────────────
    def artifact(self, job_id: str, name: str, media_type: str,
                 missing: str) -> FileResponse | JSONResponse:
        job = self.get(job_id)
        if job is None:
            return errors.job_expired()
        path = Path(job["work_dir"]) / name
        if not path.is_file():
            return JSONResponse(status_code=409, content={"detail": missing})
        return FileResponse(path, media_type=media_type)
