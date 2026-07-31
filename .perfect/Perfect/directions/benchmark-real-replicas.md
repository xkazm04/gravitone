---
slug: benchmark-real-replicas
type: perfect/direction
context: "[[Load Testing & Benchmarks]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 7057f88
---
## What & why
benchmark_arm.sh hand-rolls process scaling (spawning raw service.app on ports, arm:74-101) instead of driving python -m service.replicas; the aggregated /metrics side port is never scraped. Add --replicas mode driving the real launcher; aggregated metrics (incl timeouts/abandoned) into result JSON; delete the hand-rolled block.
## Acceptance criteria
- benchmark drives service.replicas
- aggregated side-port metrics in JSON
- sizing advisor's command is the measured one
- hand-rolled scaling deleted
## Build record
Round 3 wave 1, 2026-07-13. Director-reviewed; gates green (143 tests + tsc). Commit 7057f88. +f215b57 Director: non-Linux replica-0 warning.
