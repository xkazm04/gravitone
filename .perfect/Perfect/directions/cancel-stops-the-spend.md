---
slug: cancel-stops-the-spend
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: af67850
---
## What & why
Cancel is only honoured by `commit`. Pressing cancel during analysis or labelling leaves ~40 in-flight Gemini calls billing to the account and ~40 ffmpeg processes writing into a directory that has already been deleted. And the commit ERROR path — unlike the cancel path — performs no rollback, so an exception mid-commit leaves the voices already registered for earlier emotions live: exactly the partial Character the `/architect` round set out to eliminate, fixed for cancellation only. GC compounds it by expiring on age alone, deleting the workdir out from under a job that is still running.

## Evidence
- `service/ingest_api.py:236-254` (`_analyze`) and `:257-272` (`_label`) take no `should_cancel` and never consult `job["cancel"]`; only `ingest.commit` does (`ingest.py:457`, `:577-580`).
- `service/ingest_api.py:294-302` — `except Exception: _update(status="error"); return` (Director-verified). The `voices.remove_voices` rollback lives BELOW it in the `was_cancelled` branch (`:312-332`), so the error path never reaches it, while `ingest.commit` registers voices per-stem as it goes (`ingest.py:569-572`).
- `service/ingest_api.py:202` — `_gc_once` expires on `created + 30min` regardless of status; a long cloud scan is reaped mid-phase.
- `service/ingest_api.py:371` — `start_scan` spawns an unbounded raw `threading.Thread` per upload; nothing bounds concurrent jobs, ffmpeg spawns, or external spend (same at `:414`, `:460`).
- `service/ingest.py:586-587` → `ingest_api.py:301` → `web/app/voices/new/page.tsx:123` — 300 chars of raw child stderr rendered verbatim to the end user; `errors.sanitized_500` exists for exactly this and is used by `voices.create_voice:606` but not here.

## Acceptance criteria
- Cancel is honoured inside analyze and label, not just commit: outstanding external calls and ffmpeg work stop promptly, and nothing writes into a torn-down workdir.
- A FAILED commit rolls back the voices it created, exactly as a cancelled one does — the existing `voices.remove_voices` primitive, wired to the error path, with the same loud logging when rollback itself fails.
- GC never reaps a job that is actively running; expiry considers status, not just age.
- Concurrent ingest jobs are bounded, and the limit is a documented config value rather than an implicit "as many threads as uploads".
- The client stops receiving raw subprocess stderr; commit failures speak through `errors.sanitized_500` like the rest of the service.
- Tests: cancel during label stops the work; commit raising mid-batch leaves NO registered voices; GC leaves a running job alone.

## Risks / non-goals
- Teardown must never raise (the existing protocol's rule) — a rollback failure is logged loudly and the job still reaches a terminal state.
- Non-goal: solving multi-replica job affinity (`JOBS` is per-process; `deploy/README.md:91-104` documents it) — that is a bigger direction and stays out of this one.

## Build record
Builder I-B. Added `ingest.Cancelled` + a `_check()` checkpoint placed before each EXPENSIVE step, so cancel latency is one step rather than one phase: `analyze` polls before Scribe, before the Isolator and before the preview extracts; `label_and_stem` polls on entry, inside every pooled task before it does work, and after the pool drains. Queued batches drain instantly and only work already in flight (at most `LABEL_WORKERS`) completes; nothing writes into a torn-down workdir.

One `_rollback(job_id, created, why)` now serves BOTH the cancel and the error path. The error path needed a ledger, because on a raise there is no return value to inspect — so `ingest.commit(on_voice=...)` is called the moment each Voice is registered and `_do_commit` keeps a `registered` list. On failure it reaches a terminal state FIRST (a poller must never hang on a failed commit) and then undoes; rollback still never raises and keeps the loud ROLLBACK FAILED log.

GC: `_is_expired` ages from a `touched` heartbeat written on every `_persist`, against a status-chosen TTL — `ACTIVE_STATUSES` jobs only expire on `_RUNNING_TTL` (2h, i.e. genuinely wedged) and are still torn down cancel-flag-first. `Settings.ingest_max_jobs` (`INGEST_MAX_JOBS`, default 2, per process) bounds concurrent working jobs with 429s on /scan, /speaker and /commit, documented as a per-process ceiling that multiplies by replicas. New `errors.sanitize_detail` + `errors.UserFacing` give background phases the STRING half of the sanitized-500 contract (they cannot raise HTTPException), so the client now gets `voice cloning failed (request a1b2c3d4)` while the child stderr goes to the log against that id.

**Director review**: read `_do_commit` in full and confirmed the ledger closes the exact gap — voices registered before a mid-commit exception are now undone, where previously only the cancel path rolled back. Verified `sanitize_detail` delegates to the existing `sanitized_500` (raw cause logged, only the request id returned), so this is an extension of the established contract rather than a parallel one; the builder's own test asserts a fake path, token and "Traceback" are all absent from the detail. Both failure and cancel resolve through one `_rollback`, so they cannot drift. Gates on main: compileall clean, **389 passed, 28 subtests**. MERGED.
