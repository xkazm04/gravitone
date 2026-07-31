---
slug: sovereign-path-works
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: wildcard
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 585c816 (+ Director 3bb024d)
---
## What & why
Sovereign mode IS the product's story — Arm-native, CPU-only, no cloud, no keys, nothing leaves the box — and it is the least verified code in the repo. Speech detection uses a fixed noise floor with no adaptation to the clip's own loudness, so a quiet recording collapses into one giant span and a noisy one yields nothing and falls through to "the whole file". Labelling short-circuits to baseline for everything, so a sovereign clone has exactly one emotion. And the scout found zero tests covering any of it.

## Evidence
- `service/ingest.py:202` — `detect_speech` uses a fixed `-35 dB` `silencedetect` threshold; `:226-227` — the fallback when no spans are found is the entire file as one span.
- `service/ingest.py:376-378` — labelling short-circuits to `{emotion: baseline, model: "local"}` for every segment in sovereign mode.
- `service/ingest.py:195-199` (`clean_local`), `:202-237` (`detect_speech`), `:432-436` (`resolve_mode`) — the scout found NO tests for any of these, nor for `sovereign_analyze` end to end.
- `service/ingest.py:86` — `clean_audio` runs single-pass `loudnorm` (the non-deterministic mode), so the local chain is not even reproducible run to run.

## Acceptance criteria
- Speech detection adapts to the clip's own loudness (measure the noise floor, derive the threshold) instead of assuming −35 dB; quiet, loud and noisy inputs all produce sensible spans.
- The degenerate cases are handled explicitly and honestly: no spans found, one span covering everything, and an all-silence file each produce a clear outcome rather than a silent fallback.
- Real test coverage for the local mode: `resolve_mode` auto-selection, `clean_local`, `detect_speech` across quiet/noisy/silent fixtures, and `sovereign_analyze` end to end.
- The mode's true limits are stated to the user where they choose it — one emotion, single speaker, no diarization — rather than presented as an equivalent path to cloud.
- If two-pass `loudnorm` is adopted for reproducibility, say what it costs in wall-clock.

## Risks / non-goals
- Test fixtures must be generated (synthesised tones/noise), not committed audio blobs — keep the repo light.
- Threshold adaptation changes what gets cloned in sovereign mode; state the before/after span behaviour on the fixtures rather than claiming it is simply better.
- Non-goal: adding local diarization or a local emotion classifier — that is a much larger direction; this one makes the existing single-speaker baseline path trustworthy.

## Build record
Builder I-C (+ Director copy commit `3bb024d`). `detect_speech` now measures the clip's own level distribution (20ms frame RMS, 10th/95th percentile) and derives the silencedetect threshold from it — `min(floor+8dB, speech-6dB)` clamped to (-75, -12) — instead of assuming -35 dB. It returns a `SpeechScan` NamedTuple (was `list[dict]`) carrying an **outcome**: `spans` / `unbroken` / `silent` / `too_short`, plus a user-facing sentence and the measured levels. `sovereign_analyze` raises `errors.UserFacing` for silent/too_short instead of returning zero speakers into a caller that said "no speech detected in the clip" for every cause alike, and reports `note`, `limits`, `detection{}` (NaN-guarded, since job state is JSON-persisted and served). `resolve_mode` gained `have_cloud_keys()` — a whitespace-only key is no longer a key.

**Before/after, MEASURED** (the pre-change detector is reproduced verbatim in the test file as `legacy_detect`, so both columns execute on the same audio):
- quiet clip (speech -38, floor -80): OLD 1 span = the whole file → NEW 4 spans / 10.0s
- noisy clip (speech -12, floor -29): OLD 1 span = the whole file → NEW 4 spans / 10.0s
- hiss only (-70 dBFS): OLD 1 span of 12s → NEW `silent`, refused
- **pure digital silence: OLD returned 12 seconds of ZEROS as a span to clone from** → NEW `silent`, refused
- normal clip: unchanged (4 spans / 10.0s) — the honest cost is that nothing improves where nothing was broken
- room tone / 20s monologue: still hand back the whole file, but now SAY SO (`unbroken`) instead of being indistinguishable from a clean detection

**The builder falsified this direction's own premise, correctly.** The direction (from the scout) asserted that single-pass `loudnorm` is "the non-deterministic mode, so the local chain is not reproducible run to run". The builder tested it: three runs of the same input produced **identical sha256**. Single-pass loudnorm is adaptive, not non-reproducible — the premise conflated the two. It also measured the cost of switching anyway (60s clip, best of 3: 1.54s single-pass vs 2.49s two-pass = 1.61x) and declined, since two-pass would buy determinism the chain already has, at 1.6x the cost, on a CPU-only product, while requiring a change to the grep-pinned `CLEANUP_FILTER` shared with the cloud and direct-upload paths. Reasoning recorded in `clean_local`'s docstring with a test asserting the determinism. **Director accepts: the refusal is right and the evidence is stronger than the claim it overturned.**

**DECISION NEEDED, answered by the Director** (`3bb024d`): the last acceptance criterion — state the mode's limits where it is CHOSEN — could not be met from the backend, because the mode toggle fires before any scan exists so no backend field can reach it. The builder surfaced the limits everywhere the backend genuinely speaks (`limits[]` on the result, the progress-loader transcript line, the speaker-pick `sample_text`) and correctly returned the web string as a decision rather than editing `web/` on its own initiative. Director applied it: the old copy sold the privacy win and framed one-emotion as a workflow step while omitting single-speaker entirely, so someone cloning a two-person recording had no way to know both voices become one Character until after the scan. New copy mirrors `ingest.SOVEREIGN_LIMITS`.

**Director review**: gates on main — compileall clean, **415 passed, 28 subtests** (389 baseline + 26 new), then `tsc --noEmit` clean and 76/76 web after the copy commit. The digital-silence case alone justified the direction: the pipeline would previously have cloned a voice from twelve seconds of zeros.

**What a human must still verify by ear** (the builder's own list, kept verbatim because it is honest): thresholds are validated against SYNTHESISED fixtures (140 Hz harmonic stack, 4 Hz envelope). A real voice has consonants and breaths near the floor, and +8 dB above a measured floor may clip sibilant onsets or breath tails from span edges — clone from a real recording and compare `clean.wav` against the spans in `segments.json`, specifically whether span starts cut into the first consonant. Also untested against real material: `_SPEECH_PCT = 95` on recordings with long non-speech content (music, applause) could gate quiet speech away as `silent`; `_MIN_RANGE_DB = 8` on a heavily compressed podcast will report `unbroken` and clone the whole file. And note: threshold adaptation changes what gets cloned for existing users' quiet and noisy recordings — a re-scan of the same file will produce different stems than before.
