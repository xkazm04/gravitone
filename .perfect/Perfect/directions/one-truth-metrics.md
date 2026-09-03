---
slug: one-truth-metrics
type: perfect/direction
context: "[[Concurrency Engine & Metrics]]"
lens: ux
status: rejected
size: M
proposed: 2026-07-13
---
## What & why
Unify duplicate percentile/RTF math between engine.py:141-166 and loadtest.py:44-49,121; time-based window; Prometheus output; queue-wait aggregation.
## Rejection
2026-07-13 — user declined at the gate. Note: replica-native-mode's aggregated /metrics may partially cover this later.
