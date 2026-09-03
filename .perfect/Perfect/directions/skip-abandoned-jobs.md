---
slug: skip-abandoned-jobs
type: perfect/direction
context: "[[Concurrency Engine & Metrics]]"
lens: optimization
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: b5bae02
---
## What & why
A 504'd or disconnected client's job keeps running — wait_for only abandons the wait; the worker burns a full generation and holds its admission permit. Mark jobs abandoned on timeout/disconnect; workers skip abandoned jobs before starting; count skips/timeouts. Cap per-worker voice cache with LRU (unbounded today).
## Evidence
app.py:109-112; engine.py:253-278; engine.py:210, 222-223 (voice cache).
## Acceptance criteria
- abandoned queued jobs never start; permits release immediately on skip
- timeout + abandoned counters in /metrics
- voice cache bounded with LRU
- mocked-engine tests
## Risks / non-goals
No mid-generation cancellation (model call is atomic); coordinate with [[keys-error-hardening]]'s timeout counter — same metric, one implementation.
## Build record
Wave 2, 2026-07-13. Opus builder; Director-reviewed; gates green (compileall + 73 unittests). b5bae02 (+28b68a0 stream-abandon fix, Director). Note: export_stems in-process serializer is verified by load-back + falls back to the proven pocket_tts export-voice CLI; needs one integration run on a box with the model.
