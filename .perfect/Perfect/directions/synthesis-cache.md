---
slug: synthesis-cache
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: optimization
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 917e012
---
## What & why
Nothing in the service caches synthesis. An identical `(voice_id, text, overrides, emotion)` request re-renders from scratch every time, and N identical concurrent requests each consume a worker permit. On a CPU-only Arm box that is the difference between an instant demo replay and another full render — and it is the cheapest available protection for the queue during a demo or load test.

## Evidence
- No cache anywhere in the synthesis path: `service/app.py` (routes), `service/engine.py` (submit/worker) — the only cache is the per-worker-thread voice-state LRU (`engine.py:310,320,324-337`), which is per thread, not shared, and caches voice state, not audio.
- `service/app.py:469` / `:697` / `:786` — every route path goes straight to `ENGINE.submit`.
- Repeated-identical traffic is real: the playground has no client-side dedupe either (`web/app/playground/_variants/PlaygroundConsole.tsx:425-457`), and the bench harness replays fixed prompts.

## Acceptance criteria
- Bounded LRU (byte-budgeted, env-configurable, off by default or on by default — builder's call, documented) keyed on the FULL request identity: resolved voice id, text, overrides, frames_after_eos, and the resolved emotion — never the pre-resolution address.
- Concurrent identical requests collapse to a single synthesis (single-flight), the rest awaiting the same result rather than taking permits.
- Invalidation when a voice's underlying safetensors change (mtime/size), so a re-cloned voice never serves stale audio.
- `X-Cache: hit|miss` response header, and on a hit the timing headers report the truth (a fabricated `X-Synth-Seconds` on a cache hit is a lie — report the real near-zero value and keep `X-Audio-Seconds` accurate).
- Tests: hit/miss identity incl. overrides and emotion sensitivity, single-flight collapse under concurrency, invalidation on voice change, and the memory bound actually evicting.

## Risks / non-goals
- Cache key correctness is the whole ballgame — any request field that changes audio and is not in the key is a wrong-audio bug. Enumerate the fields against `TTSRequest` (`app.py:157-161`) and `_overrides`.
- Per-process cache: each replica keeps its own (no shared store) — state that plainly in the docs, do not pretend it is global.
- Non-goal: disk/persistent cache, and non-goal: caching the streaming route's segments this round unless it falls out for free.

## Build record
Builder S1. New `service/cache.py`: byte-budgeted LRU + single-flight in one object. The leader ALWAYS resolves its flight in a `finally`; a CANCELLED leader leaves value/error unset so a follower is elected rather than inheriting a cancellation that was never its own (unit-tested). Errors are shared, never stored. Key (`app._cache_key`, enumerated in its docstring): resolved voice id (never the `sarah:excited` address), `(mtime_ns, size)` fingerprint of that voice's safetensors, verbatim text, the overrides that actually reach the model, `frames_after_eos`, and process-wide `max_tokens`/`language`/`quantize`. Deliberately EXCLUDED and tested-as-excluded: `similarity_boost`/`style` (inert → must hit) and `output_format` (derived from the cached native-rate WAV after lookup → must hit). `X-Cache: hit|miss`; a hit reports what IT spent (µs), `X-Queue-Seconds: 0.0`, RTF from that real number, `X-Audio-Seconds` still the clip's true duration. `/metrics` gained a `cache` block. Defaults ON at `TTS_CACHE_BYTES` = 128 MiB; 0 disables cache AND collapsing. PER PROCESS — stated in the module docstring, the config comment, the app comment and the commit body (N replicas ⇒ N caches, RSS = budget × replicas).

Scope boundary the builder chose and flagged: applied to the drop-in non-stream route only. `/v1/speak`, `/v1/performance` and `/stream` stay uncached (per-segment keying would restructure the batch/abandon flow). Accepted — recorded as a round-5 candidate.

Risk it found and handled: the cache is a process-wide singleton, so four existing test classes that reuse another case's (voice, text, settings) began asserting against a previous test's audio — they now `SYNTH_CACHE.clear()` in setUp, runner-agnostic (no conftest, so `python -m unittest discover` still works).

**Director review**: read `cache.py` in full and the app integration. Verified the cache-key enumeration against `TTSRequest`'s actual fields — every field that can change audio is in the key, and the two exclusions are provably inert. Verified the leader/follower/cancelled-leader state machine (exactly one of value/error set before `event` fires; a cancelled leader loops a follower into leadership) and that a follower never holds an admission permit. Verified the honest-timing requirement: on a hit the headers report this request's real near-zero spend, not a replay of the original render — the criterion that would have failed the review had it been faked. Gates on main: 274 passed + 23 subtests. MERGED.
