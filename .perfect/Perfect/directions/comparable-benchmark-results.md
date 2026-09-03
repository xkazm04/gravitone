---
slug: comparable-benchmark-results
type: perfect/direction
context: "[[Load Testing & Benchmarks]]"
lens: ux
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 11d8d5f
---
## What & why
Result JSON has no schema version/git SHA/torch/fpmath (loadtest.py:246-247); /health config printed then discarded (:199); no in-harness warmup (:194-198); per-level sample counts differ (:212).
## Acceptance criteria
- JSON carries schema_version+SHA+torch/fpmath+server config
- warmup before level 1
- equal per-level samples
- small-n warning
## Build record
Round 3 wave 1, 2026-07-13. Director-reviewed; gates green (143 tests + tsc). Commit 11d8d5f.
