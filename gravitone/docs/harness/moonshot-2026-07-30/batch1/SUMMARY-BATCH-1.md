# Batch 1 — "The Studio Hears Itself" — SHIPPED

> 5 features, 5 parallel Opus builders, 7 commits on `vibeman/moonshot-batch-1`.
> Gates: service 52 modules / 876 tests / 0 fail (baseline 713 → +163);
> web tsc clean, next build PASS, vitest 350/351 (the 1 = pre-existing load-sensitive
> PlaygroundConsole flake, test last touched on main at `a854091`, red in the pre-batch
> baseline too, green in isolation).

## Commits
| Commit | Feature | Scope |
|---|---|---|
| `fafc00c` | Signal Layer | AudioBus + `--gt-*` token unification + live equalizers + TakePlayer |
| `f275d3e` | Measured Emotion Space | prosody.py probe + label_check + measured resolve() fallback |
| `86667c8` | Fidelity Ledger | measure_fidelity + SignalChip rack/roster UX + re-record deep-link |
| `eecc91a` | Fidelity Loop | voiceprint.py + ingest fidelity payloads + commit-time identity score |
| `8a5827e` | Audition Room | scratch auditions + splice recipes + blind X/Y review drill-down |
| `a6a587e` | (docs) design | EXECUTION-PLAN + DESIGN-BATCH-1 |
| (last) | integration | app.py prosody wiring + GuidedRecorder TakePlayer + reports |

## Cross-builder integration performed by the orchestrator
- `voices.prosody_map()` added (E-SPACE's spec; F-LEDGER hadn't picked it up) and wired into
  the 3 `resolve()` call sites in app.py (hoisted out of per-segment loops) — measured
  fallback is now LIVE, cold start unchanged.
- GuidedRecorder's raw `<audio controls>` → `<TakePlayer compact hue label>` (last raw
  audio chrome in the app).
- AuditionPanel deliberately keeps the page's single-audio-element pattern (correct for A/B —
  one take plays at a time); TakePlayer swap there deferred as polish.

## Notable catches during the batch
- **F-LEDGER security catch**: FastAPI bound `fidelity_identity` as an optional QUERY param on
  the clone route — any caller could assert identity 0.99. Now keyword-only + schema-pinned test.
- **E-SPACE design correction**: z-scored Euclidean nearest-neighbour was useless (most-average
  slot always won); shipped cosine-over-z-space. Baseline has no prior (origin, not direction).
- **F-LEDGER measurement honesty**: `vad.SpeechGate` false-flagged good loudnorm'd takes
  (`speech_seconds: 0`); shipped a two-ended threshold matching `ingest.measure_levels`.

## Deferred (recorded per proposal)
- Fidelity Loop: beam-search stem optimization, threshold refusals + calibration.
- Audition Room: embedding second opinion, recipe won/lost stats, warm-child reuse.
- E-SPACE: affect plane / coordinate addressing / coverage-as-area (custom emotions currently
  decline to the deterministic tail — tested + documented).
- F-LEDGER: emotion-separation metric (build on prosody space), `.gravichar` fidelity/prosody
  row travel (verify packs.py copies rows wholesale — batch 2), threshold calibration set.
- SIGNAL polish hooks: `useSignalHue`/`useSignalWorking` one-liners on character page /
  EmotionPicker / audition; TakePlayer in AuditionPanel.

## UX vocabulary established (batch contract, reuse in later batches)
Signal chip = named measured fact (amber flags / cyan clean facts); "identity match" never
"quality"; absent = invisible; advisory never blocking; no raw audio chrome; tokens only.
