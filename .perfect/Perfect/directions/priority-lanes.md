---
slug: priority-lanes
type: perfect/direction
context: "[[Concurrency Engine & Metrics]]"
lens: feature
status: rejected
size: M
proposed: 2026-07-13
---
## What & why
Two-lane queue (interactive vs long-form, premium scope priority, per-key fairness) over the single FIFO (engine.py:293).
## Rejection
2026-07-13 — user declined; replica-native mode accepted instead (scheduling matters less once scaling is per-process). Don't re-present unless single-process deployments stay primary.
