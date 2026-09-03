---
slug: sovereign-hears-speakers
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: optimization
size: M
status: shipped
proposed: 2026-08-06
accepted: 2026-08-06
shipped: 2026-08-07
commit: a55b9ba
---
## What & why
Wire the already-shipped offline diarizer (`diarize.py`: sherpa-onnx, pyannote-segmentation + CAM++ embedder, ~34 MB one-time download, no account) into sovereign mode, which today hard-codes `speaker_0`. Multi-character casting then works with zero cloud spend and no audio leaving the machine — the sovereignty story applied to the demo's best feature, and a hedge against demo-day cloud API failures.

## Evidence
- Sovereign hard-codes one speaker: `ingest.py:792` (`speaker_0`), `:909` (preview name), `SOVEREIGN_LIMITS` "single speaker — there is no local diarization" (`:653-655`).
- `diarize.py` NOT wired into ingest — only `stt.py:450` (opt-in per STT request) and `voiceprint.py:53` (embedder reuse) touch it; `ingest.py` imports only `voiceprint` (`:65`).
- Self-stated caveats: `count_is_certain` always False, counts skew high, unreliable on synthetic speech (`diarize.py:32-51`).

## Acceptance criteria
- Sovereign analyze emits real per-speaker segments + previews when local diarization finds >1 speaker; downstream speaker-pick/casting flow works identically to cloud mode.
- Model absent → behaves exactly as today (single speaker), with UI copy naming the option to download the diarizer — never a hard failure.
- Caveats surfaced honestly in UI copy (counts may split one voice in two), not hidden.
- Single-speaker clips: no regression vs today (adaptive silencedetect path preserved or superseded deliberately, stated in the diff).
- Offline test coverage for the wiring (fake diarizer, no model download in CI).

## Risks / non-goals
- Diarizer over-splitting one voice → casting board shows two "characters" for one person; mitigated by honest copy + user multi-select (they just don't cast the duplicate).
- `SOVEREIGN_LIMITS` copy and `GET /v1/ingest/modes` descriptions must be updated — stale capability copy is the round-6 "stop saying false things" bug class.
- Non-goal: replacing cloud diarization quality claims; no accuracy benchmarking beyond smoke evidence.

## Build record
Builder V-C (worktree perfect-sovereign) → e670f15, cherry-picked to main as **a55b9ba**. Approach: intersect-and-assign, spans authoritative — level detection decides WHAT is speech, diarizer only WHO; uncovered pieces inherit a neighbour's label (never dropped); duration preserved exactly; four named fallbacks (unavailable/failed/single_speaker/too_fragmented) all return the pre-diarizer segments byte-identical. `SOVEREIGN_LIMITS` constant → probed `sovereign_limits()` (builder falsified "can stay a constant" — it was already false on any box with models). Rode inside the served `detection` dict to avoid the V-A ingest_api.py seam. Gates: builder full suite 2035 passed; Director on main: tsc clean, 48 targeted service tests, 145 voices/new web tests. Unverified honestly: no real diarizer run (models not present locally; mapping proven via stub at the DiarizationResult/Turn seam). Review verdict: merge, no notes.
