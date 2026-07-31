---
slug: stream-chunk-budget
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: ac01955
---
## What & why
The streaming route submits EVERY sentence up front to decide admission before committing to the response. Admission is `workers + queue_max` = 33 permits by default, so any script longer than ~33 sentences is rejected with 429 before a single byte streams — the failure scales precisely with the input people demo with. Separately, `request_timeout_s` (120s) is applied per segment, so a 20-segment stream can hang for 40 minutes with no whole-request bound.

## Evidence
- `service/app.py:560-566` — the submit-all-up-front loop inside the `try` that maps `AdmissionRejected` → 429.
- `service/engine.py:434` — `max_inflight = workers + queue_max`; `service/config.py:59,62` — defaults 1 + 32 = 33.
- `service/app.py:581` — `asyncio.wait_for(…, timeout=SETTINGS.request_timeout_s)` inside the per-job loop.
- `service/app.py:349` `_split_sentences` — no length floor, so an 8000-char script can emit 100+ units.

## Acceptance criteria
- Sentences are coalesced to a chunk budget (small fragments merged) and submitted in a bounded rolling window rather than all at once.
- A 200-sentence script streams to completion under default config (`workers=1, queue_max=32`) — regression test.
- Backpressure semantics survive: when the engine is genuinely saturated the client still gets 429 + `Retry-After` BEFORE the streaming response begins, never a truncated body.
- One whole-request deadline replaces the per-segment timeout; a stream that exceeds it terminates the response and abandons remaining jobs (existing abandon protocol).
- In-order output and the single-WAV-header contract (`app.py:365-380`) are unchanged.

## Risks / non-goals
- The rolling window must not reintroduce a parked event-loop thread — stay on `wrap_future`/`wait_for`.
- Non-goal: sub-sentence/incremental decode (`generate_audio_stream`) — out of scope this round.
- Non-goal: mp3 streaming (still 501).

## Build record
Builder S1. Same `_chunk_text` budget, then a bounded ROLLING WINDOW: the first window is submitted before the response starts (so saturation still yields 429 + `Retry-After` with no body — the test now also asserts no `X-Stream` header), and one more segment is submitted per segment consumed. Window = `workers + 1`, override `TTS_STREAM_WINDOW`, never below 2. `test_200_sentence_script_streams_to_completion`: 200 segments through a 33-slot engine, all 200×480 bytes delivered. `test_window_bounds_concurrent_admission`: 10 segments through a capacity-2 engine. Mid-stream admission refusal is RETRIED (50ms) rather than truncating — the caller's status line is long gone, so a 429 is not available. ONE whole-request deadline `TTS_STREAM_DEADLINE_S` (600s) replaces the per-segment `request_timeout_s`; on expiry the stream ends, `metrics.on_timeout()` fires, remaining jobs go through `_abandon_all`. Waiting stays `wrap_future`/`wait_for` — no parked thread (CLAUDE.md § Event-loop discipline honoured).

Tests the builder broke and fixed honestly: streaming/compat cases asserting PER-SEGMENT mechanics now pin `chunk_chars=1` (their short fixtures coalesce to one unit at the production budget); the old per-segment-timeout test became `test_whole_request_deadline_counts_and_truncates`.

**Director review**: read the diff; the rolling window is the correct shape and the pre-response admission check preserves the backpressure contract that the acceptance criteria protect. Gates on main: 274 passed + 23 subtests. MERGED.
