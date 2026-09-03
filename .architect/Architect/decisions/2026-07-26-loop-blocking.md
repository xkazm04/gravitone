---
date: 2026-07-26
slug: loop-blocking
status: in-progress
type: weak-pattern
reach: "4 upload handlers + 2 auth deps + 2 hot-path call sites (concat_wavs ×2, record_fallback ×3)"
risk: 2
effort: m
payoff: 5
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# Blocking work executes on the shared event loop

## Context
FastAPI runs `def` handlers/dependencies in the anyio threadpool and `async def`
on the loop. Four upload handlers were written `async def` solely to `await
file.read()`, and then everything after the await inherited the loop:
- `voices.py:533 create_voice` — ffmpeg + a `pocket_tts export-voice`
  subprocess (`:577`, `:582`): a **multi-second freeze of every in-flight
  synthesis response and stream**.
- `ingest_api.py:284 start_scan` — ≤50 MB `write_bytes`, an `ffprobe`
  subprocess, 50 MB sha256, all before it hands off to its daemon thread.
- `takes.py:53 create_take` — 500-file glob/stat eviction + ≤25 MB write.
- `packs.py:116 import_pack` — zip decompress + per-blob sha256 over
  attacker-controlled sizes + per-voice writes.
Plus `auth.py:54,68`: `async def dep` → `keys.validate_key` parses the whole
`api_keys.json` under a lock **on the loop, for every authenticated request**.
In the hot path, `concat_wavs` runs inline (`app.py:628`, `:715`) while its
sibling `resample_wav_bytes` is executor-offloaded three lines away, and
`record_fallback` does an atomic JSON rewrite per fallback segment.
With `TTS_WORKERS=1 / TTS_QUEUE_MAX=32`, every loop stall holds up to 33
waiters: no future delivered, no admission decision, no stream chunk flushed.

## Decision
Mechanical, no behavior change:
1. `async def` → `def` for the four upload handlers; `await file.read()` →
   `file.file.read()` (UploadFile's underlying SpooledTemporaryFile — keeps
   `.filename`, blocking is correct in a threadpool handler).
2. `async def dep` → `def dep` in both auth dependency factories.
3. Offload the hot path: `concat_wavs` and `record_fallback` via
   `run_in_executor`, matching the treatment `resample_wav_bytes` already has.
Not changed: `_await_result` keeps `asyncio.wrap_future` (test_parallel pins
that it must not park an executor thread).

## Consequences
Positive: the loop stops stalling on subprocesses, large I/O and per-request
JSON parsing; p99 and 429/504 rates under the documented load profile improve
for reasons the engine metrics never showed (these stalls happen after
`X-Synth-Seconds` stops counting).
Negative/risks: the four handlers now occupy anyio threadpool slots (default
40) — correct trade, they are low-QPS mutations; `record_fallback` offload
makes fallback recording concurrent, so two segments falling back at once can
interleave read-modify-write on `emotion_demand.json` — it already had that
race across processes and the file is advisory demand data, not correctness
state.
Mitigations: handler-mode regression test so the modes can't silently revert.

## Rollout
1. Four handlers + auth deps → `def` — compileall + full suite.
2. Hot-path offload (concat_wavs, record_fallback) — suite.
3. Handler-mode guard test (asserts these routes are not coroutine functions) — suite green.

## Acceptance criteria
- No `async def` route performs subprocess/large-I/O work inline.
- Auth dependencies run off the loop.
- `concat_wavs` and `record_fallback` are awaited via an executor.
- A test fails if any of the four handlers or the auth deps become `async def` again.

## Regression checklist
- [ ] Upload flows still parse multipart correctly (clone, scan, take, pack import) — existing tests.
- [ ] `_await_result` still uses wrap_future — `test_parallel.py:106-114`.
- [ ] Live throughput improvement — UNVERIFIED (no local TTS runtime; needs a loadtest run on a real box).

## Pre-flight baseline
compileall clean; 190 tests OK @ 4c20acf.
