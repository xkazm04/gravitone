---
slug: streaming-ttfb
type: perfect/direction
context: "[[Load Testing & Benchmarks]]"
lens: feature
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 38071dc
---
## What & why
Streaming is the headline latency feature and unbenchmarked (loadtest times full responses only, loadtest.py:53-61). Add --route stream measuring TTFB + total per request; TTFB percentiles per level.
## Acceptance criteria
- stream mode measures TTFB+total
- TTFB p50/p95 in table+JSON
- pcm and wav
- non-stream unchanged
## Build record
Round 3 wave 1, 2026-07-13. Director-reviewed; gates green (143 tests + tsc). Commit 38071dc.
