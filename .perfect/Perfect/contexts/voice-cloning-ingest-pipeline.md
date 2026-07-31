---
name: Voice Cloning & Ingest Pipeline
type: perfect/context
group: TTS Service Core
category: api
opportunity: 8
last_proposed: 2026-07-28
cooldown_until: round 7
directions: ["[[consent-receipts]]", "[[async-commit-cancel]]", "[[parallel-label-commit]]", "[[durable-job-lifecycle]]", "[[one-true-clone-path]]", "[[neutral-baseline-stem]]", "[[input-side-seeking]]", "[[cancel-stops-the-spend]]", "[[external-call-budget]]", "[[sovereign-path-works]]"]
---
## Current state (RE-SCOUTED 2026-07-28, round 5 — the round-1 brief was largely historical)
Cloud chain: Scribe STT (diarize, 1 call) → `build_segments` greedy word-merge → Voice Isolator (1 call) → `clean_audio` (`CLEANUP_FILTER`) → per-speaker previews → `ThreadPoolExecutor(4)` × per-segment Gemini labelling (limit 40, index-stable) → per-emotion stems. Sovereign chain: `clean_local` → `silencedetect` spans → single speaker → baseline only. `resolve_mode` auto-selects when a key is missing.

Round-1..2 work CONFIRMED live: consent-receipts (422 gate + receipt stamped + `Voice.consent` surfaced), async-commit-cancel (returns immediately, per-emotion cancel, `_terminate`), parallel-label-commit (4-way labelling + ONE model load per commit via `export_stems`), durable-job-lifecycle (state.json persist/rehydrate/GC, won't resurrect a reaped workdir), api-clone-consent, create-flow-state-machine, truthful-pipeline-feedback, preview-poll-efficiency, atomic-voice-registry, registry-read-cache. `/architect`'s ingest teardown protocol is complete (cancel-before-rmtree in both cancel and GC, locked `_get_job`, every writer no-ops on cancel, `start_background()` in lifespan).

**Partial, not complete** (important):
- `one-true-clone-path` is complete as a FILTER STRING (`CLEANUP_FILTER` shared across `ingest.py:68`, `voices.py:591-594`, `clone_test.sh:28`, grep-enforced) but NOT as a path: `POST /v1/voices` still spawns the per-clone `pocket_tts export-voice` CLI (`voices.py:600-602`) instead of `export_stems`, so it gets neither the one-load win nor the round-trip load-back verification. Two export mechanisms, one filter.
- "cancelled clone leaves no partial Character" (`4413dda`) is fixed for CANCEL only — the commit ERROR path performs no rollback (Director-verified at `ingest_api.py:294-302`). → [[cancel-stops-the-spend]]

Rough (Director-verified where structural):
- **Baseline stem is a blend of every emotion** (`ingest.py:406-414`), spliced with no crossfade/level-match (`:116-118`), cap off-by-one (`:117-123`), eligibility measured on a different basis than the written file (`:414` vs `:422`). → [[neutral-baseline-stem]]
- **`to_wav` seeks AFTER `-i`** (`ingest.py:92-98`) → every extract decodes the whole file; ~40 full decodes per cloud job. → [[input-side-seeking]]
- **Cancel ignored by analyze/label** (`ingest_api.py:236-272`); GC expires on age regardless of status (`:202`); unbounded thread per upload (`:371`); raw child stderr rendered to the user (`ingest.py:586` → `page.tsx:123`). → [[cancel-stops-the-spend]]
- **2 EL + 40-80 Gemini calls per clone, zero retries** (`ingest.py:146,155,173`), unbatched, escalation doubles cost silently and misreports its model (`:184-190`), no duration ceiling (`ingest_api.py:357-359`). → [[external-call-budget]]
- **Sovereign mode: fixed −35 dB threshold, no adaptation, zero tests** (`ingest.py:202,226-227,376-378`). → [[sovereign-path-works]]
- Not taken this round: multi-replica job affinity is broken by design and only documented (`JOBS` per-process + every replica rehydrates every state.json + B's GC reaps A's workdirs — `deploy/README.md:91-104`); `job_expired()` cannot distinguish "wrong replica" from "really expired", so the web flow says "session expired, nothing was saved" for a live job; extension whitelist short-circuits the magic sniff (`ingest_api.py:82-83`); the 50 MB cap is checked after the whole body is in RAM (`:343` then `:98`); cloud mode denoises an already-isolated lossy track (`ingest.py:323-326`); `seg_*.wav` are never cleaned before TTL; `registry-read-cache` returns the SAME MUTABLE object to every caller (`voices.py:330`); `ingest.scan()` is a second orchestration of the pipeline reachable only from the CLI; `commit(allow_short=True)` and `voices.invalidate()` have no production callers; two unrelated `concat_wavs` (path-based in ingest, bytes-based in engine).

## Direction history
2026-07-13 — proposed 5, ALL accepted: consent-receipts ✅ async-commit-cancel ✅ parallel-label-commit ✅ durable-job-lifecycle ✅ one-true-clone-path ✅.
2026-07-28 — proposed 5, **all 5 accepted**: neutral-baseline-stem ✅ input-side-seeking ✅ cancel-stops-the-spend ✅ external-call-budget ✅ sovereign-path-works ✅.

## Shipped
Round 1: consent-receipts → b972668 · async-commit-cancel → 0b6d6c4 (+337d2d2 Director) · parallel-label-commit → 0407009 (+87b5bf9 Director load-back verify) · durable-job-lifecycle → 60784d3 · one-true-clone-path → 9e3a15b

Round 5 (2026-07-28) — 5/5:
- [[input-side-seeking]] → **ae12f52** — two-stage seek; a segment extract no longer decodes the whole recording. Measured: mp3 tail extract 2474ms → 115ms (21×), 40-segment pass 40.6s → 5.6s.
- [[neutral-baseline-stem]] → **5de0b31** (+ Director **89769e0**) — the neutral reference is built from baseline-labelled audio only, borrows nearest-neutral ONLY to clear the minimum and says so; splices level-matched, faded and gapped; eligibility now uses the same measurement `commit` re-takes.
- [[cancel-stops-the-spend]] → **af67850** — cancel honoured in analyze and label; a FAILED commit rolls back like a cancelled one (via an `on_voice` ledger); GC no longer reaps running jobs; concurrent jobs bounded; raw child stderr no longer reaches the client.
- [[external-call-budget]] → **05021e9** — retries on transient failures only, per-JOB retry budget, **Gemini labelling batched 40 calls → 5**, escalations counted/capped/honest, duration ceiling that fails closed.
- [[sovereign-path-works]] → **585c816** (+ Director **3bb024d**) — detection adapts to the clip's own levels; four named outcomes replace one silent fallback. **It would previously clone a voice from 12 seconds of pure digital silence.**

**Observed effect**: the whole external-API surface went from zero tests to covered; sovereign mode from zero tests to 26.
