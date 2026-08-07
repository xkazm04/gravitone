---
slug: scan-overlaps-its-cloud-calls
type: perfect/direction
context: "[[voice-cloning-ingest-pipeline]]"
lens: optimization
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 916a810
---
## What & why
The two minute-scale paid cloud calls in a cloud scan (scribe, voice_isolate) run strictly sequentially on the same source file despite independence — the largest wall-clock item in the flow, untouched across 5 rounds. After labeling, every segment wav is decoded THREE times (label pass, build_recipes' measure_levels, _board), and each debounced /stems re-runs the whole board re-read.

## Evidence
- ingest.py:955 → :969 sequential paid calls
- ingest_api.py:275/:328/:783/:1311 the three passes; :1414 restem re-board; :1491 reset re-recipes

## Acceptance criteria
- scribe ∥ voice_isolate overlap; spend/cancel semantics preserved (a failure on one still records the other's cost honestly; cancel stops both).
- Per-job memo of segment metrics (durations, levels) so recipes/board/restem share one decode; invalidated on re-splice.
- Pass-count reduction test-asserted (decode-call counter on the fake); results byte-identical.
- Step/status reporting stays truthful while calls overlap (no invented sequential steps).

## Risks / non-goals
Non-goal: parallelizing Gemini label batches further (already pooled). Keep the sovereign path untouched.

## Build record
(pending)
Build record: I-B done. scribe ∥ isolate+clean in one extra thread; scribe's error wins; transcript partial publishes pre-join; both costs on the shared persisted ledger. Stated costs: cancel abandons both (no longer prevents call 2); scribe failure waits for sibling (≤300s). Memo keyed (size,mtime_ns), lock is a leaf (deadlock-test-pinned), self-correcting. Falsified: '3 decode passes' imprecise — 3n header reads→n + full re-decodes→0 on reset. Byte-identical proven. Merged 916a810.
