---
slug: streaming-synthesis-endpoint
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: feature
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: d6d15bd
---
## What & why
The whole product returns fully-buffered audio: latency to first byte = full synthesis time. Streaming is ElevenLabs' headline feature and our biggest compat hole. Ship POST /v1/text-to-speech/{voice_id}/stream: sentence-split the text, submit segments to the pool, stream each segment's PCM/WAV chunks as they finish (chunked transfer). First-audio latency drops from O(full text) to O(first sentence).
## Evidence
app.py:194 (buffered Response); engine.py:39-49 (whole tensor → WAV bytes).
## Acceptance criteria
- /stream route returns chunked audio; first chunk arrives before the last segment is synthesized
- works for pcm + wav (mp3 may return 501)
- timing headers preserved per-stream
- non-stream route unchanged
## Risks / non-goals
No websocket /stream-input; no model-level incremental frames (sentence granularity is fine for v1).
## Build record
Wave 1, 2026-07-13. Opus builder; Director-reviewed diff; gates green (compileall + unittest + tsc). Commit d6d15bd.
