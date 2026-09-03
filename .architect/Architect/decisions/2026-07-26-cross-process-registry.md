---
date: 2026-07-26
slug: cross-process-registry
status: in-progress
type: structural-bug-class
reach: "1 primitive (mutate_meta) × N replica processes; every clone/import/patch/delete write path"
risk: 3
effort: m
payoff: 4
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# Registry mutation lock is per-process under a multi-process topology

## Context
`mutate_meta` (`voices.py:212`) serializes registry read-modify-write under
`_META_LOCK`, a `threading.RLock` — per-process only. The service is deployed
as N single-worker processes (`replicas.py`, `SO_REUSEPORT`). Two replicas can
each `_load_meta()`, each add a voice, and each `_save_meta()`: `os.replace`
guarantees no torn file, but the second save silently drops the first's entry.
Meanwhile `takes.py:230-245` already solves exactly this class with an
`O_CREAT|O_EXCL` sentinel that is atomic across processes — the repo had the
right primitive in one module and the wrong one in the other.

## Decision
Generalize the sentinel into `atomicio.file_lock()` — a waiting cross-process
mutex with stale-lock reclamation (a SIGKILLed holder must not wedge the
service; `docker stop`'s 10s and k8s grace expiry make that a real path) — and
take it in `mutate_meta` alongside the existing thread lock. On contention
beyond the timeout it raises `TimeoutError` rather than proceeding unlocked:
silently losing a registry update is worse than failing the request loudly.

## Consequences
Positive: concurrent clones/imports across replicas can no longer drop each
other's voices; one documented primitive for cross-process exclusion.
Negative/risks: a wedged holder now blocks writers for up to LOCK_TIMEOUT_S
(10s) before erroring — bounded and logged; stale-breaking at 60s could in
principle break a *live* lock held longer than 60s, but every mutation here is
a JSON load+save (milliseconds), so a 60s hold means the holder is dead.
`file_lock` lives on the same filesystem as the registry — a network FS with
broken `O_EXCL` semantics would weaken it (not the shipped topology).
Mitigations: 6 tests covering exclusion, release, timeout, stale-break,
exception-safety, and that `mutate_meta` actually holds it.

## Rollout
1. `atomicio.file_lock` + `mutate_meta` adoption + tests — compileall + suite. ✅ (206 OK)

## Acceptance criteria
- A second holder waits, then acquires after release. ✅
- Lock file removed on release and on exception. ✅
- Timeout raises rather than proceeding. ✅
- A stale (killed-holder) lock is reclaimed. ✅
- `mutate_meta` holds the lock file for the duration of the mutation. ✅

## Regression checklist
- [x] Existing registry tests (atomic write, racing mutators, cache) pass — 206 OK.
- [ ] True multi-PROCESS contention — UNVERIFIED (single-process test run; needs a replicas-mode box).
