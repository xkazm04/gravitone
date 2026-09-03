---
slug: promises-are-measured
type: perfect/direction
context: "[[concurrency-engine-metrics]]"
lens: honesty
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 8237212
---
## What & why
The engine stamps `X-Gravitone-Deadline` promises and never checks whether it keeps them: `promised_s` is written once, read into a header, never compared to actual latency — the batch-5 design explicitly required deadline-hit rate + promise error. The degrade ladder's 0.7/0.5 cost fractions are invented constants presented inside a "measured" promise, and `_degrade` degrades quality even when no rung can save the deadline (cheapest audio AND a missed deadline). "Make an existing number true" — the accepted pattern.

## Evidence
- engine.py:1420 promised_s written; app.py:383 header; nothing records hit/miss
- docs/harness/moonshot-2026-07-30/concurrency-engine.md:67 the requirement
- engine.py:125-129 invented fractions; :1419 warm gate skips them; :1330-1352 degrade-even-when-hopeless
- engine.py:1292-1312 `_pending_est_s` increment/decrement only, never reconciled

## Acceptance criteria
- Metrics record promise-vs-actual (hit rate, signed error) with a production writer (wiring-checked, round-6 lesson).
- When no ladder rung fits, fail at full quality rather than degrade pointlessly.
- Promise header distinguishes measured basis from guessed (or refuses to promise on unmeasured fractions).
- `_pending_est_s` reconciles against the real queue (periodic or on-drain recompute).
- Tests: a kept promise, a broken promise, the no-rung-fits path.

## Risks / non-goals
Non-goal: any web/UI readout — /metrics + headers only. Same builder as [[deadline-reaches-every-route]].

## Build record
(pending)
Build record: E1 done. snapshot()["promises"] nested (AGG_KEYS-safe), production writer via worker on_finish. Ladder fractions measured (warm window 8) else promise WITHHELD on assumed basis. _degrade returns False when no rung fits (full quality + unfittable counter). _pending_est_s reconciled event-driven 1s under _pending_lock. Builder falsified brief: submit() double-counted the job's own render in every promise — fixed (queue_wait vs predicted split). Merged 8237212.
