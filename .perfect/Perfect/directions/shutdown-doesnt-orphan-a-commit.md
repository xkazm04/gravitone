---
slug: shutdown-doesnt-orphan-a-commit
type: perfect/direction
context: "[[voice-cloning-ingest-pipeline]]"
lens: robustness
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: ff08ad7
---
## What & why
lifespan drains only the engine; every ingest thread is daemon and unjoined. SIGTERM mid-commit leaves half a Character registered forever (_rollback lives after the loop; rehydrate relabels "interrupted" without undoing). A cancelled rederive's replaced-voices receipt survives only in a server log — the API answers bare {"status":"cancelled"}.

## Evidence
- app.py:113-128 engine-only drain; ingest_api.py:1092/:1171/:1637/:1722 daemon threads; :671 _gc_loop no stop flag
- :949-955 rollback after loop; :590 rehydrate relabel; :1025-1030 rederive keep-list logged only; :1764 cancel pops job

## Acceptance criteria
- Ingest threads get stop flags + joins in lifespan (bounded wait; report what could not finish).
- A commit interrupted by shutdown either completes registrations or rolls back on next startup (startup reconciliation of "committing" jobs).
- Rederive outcome (replaced voices) reaches the API response for cancelled AND completed jobs.
- Drain tests (test_drain.py is engine-only today); a startup-reconciliation test.

## Risks / non-goals
Non-goal: making commit atomic across SIGKILL (only SIGTERM-window discipline + startup repair).

## Build record
(pending)
