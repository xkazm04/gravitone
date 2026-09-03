---
slug: worker-death-is-visible
type: perfect/direction
context: "[[Concurrency Engine & Metrics]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 718a790
---
## What & why
Two total-outage paths, both live today. A model-load failure in a worker thread hangs startup forever: the process binds no port, serves no `/health`, and logs nothing beyond the thread's traceback. And a worker that dies mid-loop dies silently: `ready` stays set, `/health` keeps returning 200, and permits drain to zero as jobs pile into an unbounded queue nobody serves — the replica answers 429 forever while looking healthy to every supervisor above it.

## Evidence
- `service/engine.py:482` — `TTSModel.load_model` outside any `try`; `:490` `ready.set()` only on success; `:594-595` `start()` does `w.ready.wait()` with NO timeout, called from the lifespan executor (`app.py:72`).
- `service/engine.py:492-519` — the worker loop has no outer `try` around `queue.get` / `abandoned.is_set()` / `on_start()`; an exception there kills the thread.
- `service/app.py:1119` — `/health` reports readiness from the one-time flag, not from live workers.
- `service/engine.py:580` — the queue is unbounded; the semaphore is the only bound, so a dead consumer means permits never return.
- `service/replicas.py:283-284` — the supervisor restarts dead PROCESSES only; an alive process with a dead worker thread is invisible to it.

## Acceptance criteria
- A model-load failure fails startup promptly and loudly (a real error, a real log, a non-zero exit) instead of hanging forever — and a partial failure (1 of N workers) is equally visible.
- The worker loop either survives an unexpected exception or dies in a way the process notices.
- `/health` reflects live workers, so a replica with no functioning worker cannot report itself ready — this is what lets the existing process supervisor do its job.
- Tests for both paths: load failure at startup, and a worker dying mid-loop.

## Risks / non-goals
- Restart-on-death must not mask a deterministic crash loop — bound it and make the giving-up state visible.
- Non-goal: rewriting the drain protocol (it is correct and well tested) or changing the process supervisor.

## Build record
Builder E-A. Workers now record the load attempt on a `startup_done` event (set on success AND failure) plus `load_error`; `start()` waits on it with `_MODEL_LOAD_TIMEOUT_S` (env-overridable, default 600s) instead of an un-timed `ready.wait()`, logs CRITICAL, stops the half-started pool and raises `EngineStartupError` chained to the real cause — so uvicorn exits non-zero instead of hanging with no port bound. The worker loop split into `_serve_forever`/`_serve_once`/`_run_job`: scaffolding errors survive up to `_LOOP_ERRORS_MAX=5` consecutive times; a job's BaseException still resolves the future and releases the permit before re-raising; every exit clears `ready` and calls `_worker_exited`, which replaces the slot at most `_WORKER_RESTART_MAX=3` times then gives up with a CRITICAL log and a terminal `failed` state (crash loops are not masked). `/health` reads `live_workers` (alive AND loaded), returns 503 once the engine gave up, and reports `workers_live`/`workers_configured`.

Builder found and fixed a real bug while testing: `stop()` joined every slot in `_workers` including a replacement created but not yet started, raising `RuntimeError: cannot join thread before it is started`.

**Director review**: read the diff. Accepted the strictness trade-off the builder flagged — `TtsEngine.ready` requires every configured worker alive and loaded, so with N>1 one dying briefly flips /health to 503 during restart. That is honest (the replica IS degraded) and the shipped default is 1 worker per replica. Gates on main: 324 after the E-A+E-B integration run. MERGED.
