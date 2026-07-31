---
date: 2026-07-26
slug: ingest-teardown
status: in-progress
type: structural-bug-class
reach: "8 sites in ingest_api.py (GC, 3 phase threads, 2 preview routes, rehydrate, import-time start)"
risk: 3
effort: m
payoff: 4
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# Ingest teardown races itself

## Context
Six defects around job teardown, all in `ingest_api.py`:
1. `_gc_once` (`:184`) reaps an over-TTL job by `rmtree` **without setting
   `cancel`** — unlike `cancel_job` (`:411`), which sets the flag first. A
   commit outliving the TTL keeps running, and `_persist` (`:120`) does
   `wd.mkdir(parents=True, exist_ok=True)`, **recreating the directory GC just
   deleted** as an unowned orphan, while the export child reads from a tree
   that vanished.
2. Phase threads open with a bare `JOBS[job_id]` (`:214`, `:232`, `:257`)
   outside their `try` — a DELETE landing between `Thread.start()` and that
   line kills the thread with an uncaught `KeyError` on a bare thread stack.
3. `speaker_preview` (`:334`) and `preview` (`:364`) read `JOBS` unlocked while
   the sibling `get_job` guards, violating the module docstring's own
   "all JOBS mutations + persistence happen under a single lock".
4. A cancelled commit silently discards `created` (`:273-275`): the emotions
   already cloned stay registered as a live partial Character, and the comment
   claims DELETE "cleaned up" — DELETE cleans the workdir, not `VOICES_DIR`.
5. `_rehydrate` (`:178`) is the one non-atomic write to `state.json`.
6. `_rehydrate()` + the GC thread start **at module import** (`:428-429`), so
   real disk work happens before the app is ready, outside lifespan
   supervision, and every process that imports the module for any reason
   spawns a GC thread that can delete another replica's workdirs. Tests share
   that live thread with production globals.

## Decision
- GC honors the teardown protocol: mark `cancel` under the lock **before**
  rmtree, exactly like `cancel_job`.
- `_persist` never resurrects a reaped workdir — write only if the directory
  still exists.
- Phase threads resolve their job through `_get_job()` (locked `.get`) and
  return quietly when it's gone.
- Preview routes read under `_LOCK`.
- A cancelled commit **logs the voices it already created** (new module logger)
  instead of dropping them silently. Full rollback is deliberately NOT done
  here — deleting registry entries is destructive and unverifiable without a
  runtime; queued as a follow-up.
- `_rehydrate` uses the same tmp+replace as `_persist`.
- Import-time side effects move into an explicit `start_background()` called
  from the app lifespan, idempotent, with an immediate first sweep so
  post-restart orphans aren't stranded for 5 minutes.

## Consequences
Positive: teardown has one protocol; no orphan resurrection; no silent thread
deaths; tests no longer share a live GC thread with production globals.
Negative/risks: `start_background()` must actually be called or rehydrate never
runs — wired into lifespan and asserted by a test; a cancelled commit still
leaves registered voices (now loudly logged, not silent).
Mitigations: tests for the GC/commit interaction, the locked accessor, and
lifespan wiring.

## Rollout
1. GC cancel-before-rmtree + `_persist` no-resurrect + `_get_job` + locked previews + cancel logging + atomic rehydrate — suite.
2. `start_background()` + lifespan wiring + tests — suite green.

## Acceptance criteria
- GC sets `cancel` before deleting; a running commit sees it and stops.
- `_persist` on a reaped workdir writes nothing.
- A phase thread whose job was deleted exits without raising.
- Cancelled commit logs the orphaned voice ids.
- No thread starts at import; lifespan starts exactly one.

## Regression checklist
- [ ] Existing ingest lifecycle tests (cancel, rehydrate, GC) still pass.
- [ ] Full-runtime ingest flow — UNVERIFIED (no local TTS runtime).

## Pre-flight baseline
compileall clean; 194 tests OK @ loop-blocking commit.
