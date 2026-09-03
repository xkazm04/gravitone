---
slug: graceful-drain-shutdown
type: perfect/direction
context: "[[Concurrency Engine & Metrics]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 81ccb72
---
## What & why
stop() sets _stopping and workers exit after their current job — jobs queued ahead of the sentinels are never resolved; callers hang until the 120s timeout → 504; workers aren't joined and in-flight generation dies with daemon threads. Drain: reject new submits, resolve every queued future (finish or fast 503), join workers with a deadline.
## Evidence
engine.py:237, 306-309; app.py:50 (lifespan).
## Acceptance criteria
- shutdown resolves every pending future (result or immediate 503, never a hang)
- workers joined with timeout
- lifespan waits for drain
- tests with mocked model
## Risks / non-goals
Keep daemon threads as last-resort backstop.
## Build record
Wave 2, 2026-07-13. Opus builder; Director-reviewed; gates green (compileall + 73 unittests). 81ccb72. Note: export_stems in-process serializer is verified by load-back + falls back to the proven pocket_tts export-voice CLI; needs one integration run on a box with the model.
