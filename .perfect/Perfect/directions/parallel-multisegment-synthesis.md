---
slug: parallel-multisegment-synthesis
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: optimization
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 1f432df
---
## What & why
/v1/speak and /v1/performance synthesize segments strictly serially — each awaits the previous segment's full result, so a 10-segment script takes 10× serial latency while pool workers idle. Submit all segments concurrently (bounded by pool admission), gather in order, concat. Also stop parking a default-executor thread per in-flight request.
## Evidence
app.py:257-272; app.py:326-344; app.py:110 (run_in_executor(None, job.future.result)).
## Acceptance criteria
- multi-segment requests use ≥2 workers concurrently
- output ordering byte-identical to serial
- queue backpressure still returns 429
- no executor-thread-per-request wait
## Risks / non-goals
Don't exceed pool admission (flooding queue → spurious 429s for other clients); keep per-segment 429 handling coherent.
## Build record
Wave 1, 2026-07-13. Opus builder; Director-reviewed diff; gates green (compileall + unittest + tsc). Commit 1f432df.
