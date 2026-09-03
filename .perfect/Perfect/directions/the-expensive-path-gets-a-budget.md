---
slug: the-expensive-path-gets-a-budget
type: perfect/direction
context: "[[voice-cloning-ingest-pipeline]]"
lens: robustness
status: shipped
size: S
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 8f96dd4
---
## What & why
The ingest router carries no rate budget while round 9's DEMO_CLONE_BUDGET protects the CHEAP single-stem clone. One anonymous IP triggers 2 ElevenLabs + 5-8 Gemini calls + a torch model load per scan, repeatedly. _SPEND retry budgets are per-process, so a rehydrated job on a second replica gets fresh spend.

## Evidence
- app.py:2487 scope-only mount vs :2483 voices_router budget; config.py:155 escalation budget 12
- ingest.py:393 _SPEND per-process; ingest_api.py:1092 scan thread

## Acceptance criteria
- Per-IP budget on scan + audition routes (round-9 shared-window limiter; env-tunable, demo-sized).
- Spend ledger persists with the job so rehydration cannot mint fresh retry budget.
- 429 copy states the real effective budget (describe() precedent).
- Tests incl. multi-process where the shared window is involved.

## Risks / non-goals
Studio traffic arrives via the proxy host IP — size limits for a live demo. Non-goal: any spend UI.

## Build record
(pending)
