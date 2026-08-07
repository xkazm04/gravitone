---
slug: one-box-many-processes-one-truth
type: perfect/direction
context: "[[voice-cloning-ingest-pipeline]]"
lens: robustness
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 85c5b57
---
## What & why
The ingest job store is the exact cross-process anti-shape round 9 fixed elsewhere: bare RLock guarding state.json all replicas write, fixed tmp filename (torn writes), _rehydrate loads every job into every replica, GC reaps other replicas' workdirs, MAX_ACTIVE_JOBS per-process (4 replicas admit 8 while the 429 says 2). Plus restem↔commit TOCTOU: /stems can rewrite the stem file a concurrent commit's export child is reading.

## Evidence
- ingest_api.py:136 RLock; :513-525 _persist fixed tmp `state.json.tmp` (atomicio.atomic_write_text exists; corpus index uses it at ingest.py:1986)
- :572-592 _rehydrate; :660-668 GC cross-replica (deploy/README.md:215 documents-not-fixes)
- :153/:165 per-process admission; :628 the lying 429
- :1401-1410 restem unlocked status read vs :1629 commit flip — locks don't compose

## Acceptance criteria
- file_lock + atomic per-process-tmp writes on the job store; rehydrate/GC ownership-aware.
- Admission honest across replicas (shared count or honest copy — builder recommends).
- restem-vs-commit race closed (locks compose or status re-check under the stem lock).
- Cross-process tests (test_file_lock pattern); today deleting _LOCK fails no test.

## Risks / non-goals
Non-goal: moving JOBS out of process memory entirely (replica-affinity is documented design; the FILE is the shared truth to protect).

## Build record
(pending)
