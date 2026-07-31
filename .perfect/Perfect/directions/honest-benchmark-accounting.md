---
slug: honest-benchmark-accounting
type: perfect/direction
context: "[[Load Testing & Benchmarks]]"
lens: optimization
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 0267e77
---
## What & why
Reported server CPU includes the load generator (whole-host sampler, loadtest.py:83-84); 504s vanish into errors (:66-71); /metrics never read. Sample server PID CPU separately; per-level /metrics deltas; timeouts counted; driver-saturation warning.
## Acceptance criteria
- server vs driver CPU separate
- /metrics deltas per level in JSON
- 504s as timeouts
- driver-saturation warning
## Build record
Round 3 wave 2, 2026-07-13. Director-reviewed; 161 tests green. server/driver/host CPU split (--server-pid wired in both scripts), 504s first-class in the degradation rule, single-mode /metrics deltas, driver-saturation flag. Commit 0267e77.
