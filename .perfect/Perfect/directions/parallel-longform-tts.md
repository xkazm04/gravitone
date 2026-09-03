---
slug: parallel-longform-tts
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: optimization
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 8c4389e (+ fix 2725d2a)
---
## What & why
`POST /v1/text-to-speech/{voice_id}` — the ElevenLabs-compatible route every external client calls — submits the entire ≤8000-char body as ONE engine job, so long-form text is synthesized by a single worker no matter how many workers/replicas are running. Every other synthesis path in the service already parallelizes: `/stream` sentence-splits, `/v1/speak` and `/v1/performance` batch through `_submit_batch`/`_gather_results` (shipped round 1). This is the last serial path, on the most-used route.

## Evidence
- `service/app.py:469` — `_submit_and_wait(voice_id, req.text, …)`: whole body, one job.
- `service/app.py:555-566` — `/stream` splits via `_split_sentences` and submits per sentence.
- `service/app.py:232` `_submit_batch`, `:250` `_gather_results`, used at `:697` (`/v1/speak`) and `:786` (`/v1/performance`).
- `service/engine.py:53` `concat_wavs(list[bytes])` — the proven in-memory concat the batch routes already use.

## Acceptance criteria
- Long text is split into synthesis units, submitted as a batch, and concatenated in request order using the existing `concat_wavs` path — no new concat implementation.
- Single-unit input (no sentence-final punctuation, or short text) produces a byte-identical response to today's, including headers.
- Timing headers stay honest: `X-Synth-Seconds` reports wall-clock for the whole request (not the sum of per-segment times); `X-Realtime-Factor` derived from it.
- Batch admission failure abandons all sibling jobs (reuse the round-1 abandon protocol) and still returns the 429 + `Retry-After` shape.
- Test proves an N-sentence body occupies N workers concurrently, and a regression test pins the single-unit byte-identity.

## Risks / non-goals
- Segment seams must not click or drift — reuse `/v1/speak`'s concat, do not invent a new one.
- Non-goal: metatag/emotion grammar on this route (that is `/v1/speak`'s job); the splitter stays plain-text like `/stream`'s.
- Coordinate with [[stream-chunk-budget]] — both touch segmentation; if a shared chunk-budget helper emerges, one builder owns both.
- **Report finding**: `SETTINGS.max_tokens = 50` (`config.py:79`) is passed to every job and `submit(max_tokens=…)` (`engine.py:520`) is a dead parameter no caller ever uses, though `config.py:78` claims it is "overridable per request". If that budget caps per-job output length, segmentation also removes a silent truncation ceiling — the builder must determine the real semantics and report, not silently change the default.

## Build record
Builder S1 (branch e49ecae → main **8c4389e**; fix commit aa016bb → main **2725d2a**). New `_chunk_text` = `_split_sentences` + coalesce to `TTS_CHUNK_CHARS` (350); multi-unit bodies go through the EXISTING `_submit_batch` → `_gather_results` → `_offload(concat_wavs, …)` path (no new concat). `_submit_batch` gained an optional `frames_after_eos`. Single-unit bodies take the original single-job path byte-for-byte, pinned by `test_longform.SingleUnitUnchangedTests`. `X-Synth-Seconds` on a segmented response is request wall-clock (test: 4×0.2s segments report ~0.2s, not 0.8s), plus a new `X-Synth-Segments`. N-worker proof and 429+abandon both tested.

**Director REDO — the one defect of the round.** The builder's `_chunk_text` docstring claimed "the unit count is bounded by len(text)/budget, so the whole batch fits the engine's admission window", and the commit message repeated it as "at most 23 units against a 33-slot window". FALSE: greedy coalescing only merges when the COMBINED length fits, so sentences longer than budget/2 never merge and the count tracks sentence count. Director measured it against the builder's own implementation on an 8000-char body: **176-char sentences → 45 units, 180 → 44, 200 → 40** vs 33 admission slots. ~180-char sentences are ordinary prose, so a max-length request would 429 on a route that previously never rejected for length — the exact failure mode [[stream-chunk-budget]] exists to remove, reintroduced on the batch route. Sent back with the measurements and a required table-driven test.

**Fix (aa016bb → 2725d2a)**: `_chunk_text(text, max_units=None)` now DOUBLES the budget until the count fits, terminating because a budget of `len(text)` merges everything into one unit. The builder correctly REJECTED the Director's suggested `max(chunk_chars, ceil(len/MAX_UNITS))` formula, arguing it only guarantees half-full units and so tightens the bound without making it true — "precisely the kind of reasoning that produced the original false claim". Accepted: that is right. `_max_batch_units() = min(16, (workers+queue_max)//2)`, floored at 1 so a tiny queue degrades to the original single-job request. The STREAMING route deliberately passes no cap (its rolling window means unit count costs no admission, and finer units mean lower TTFB) — asymmetry stated in both docstrings and pinned by `test_streaming_style_chunking_is_not_capped`.

**Director verification of the fix**: re-ran the bound independently across sentence lengths 5→9000 on 8000-char bodies — batch units peak at **16 ≤ cap 16 ≤ window/2**, no text lost or reordered, stream path uncapped as designed. The false claim was also hunted down in all three places it lived (`_chunk_text`, the route docstring, `config.py`'s `chunk_chars` comment) — verified gone (`grep "23 units"` → no hits). Gates on main: compileall clean, **274 passed + 23 subtests**. MERGED.
