# Batch 6 — "Expression Frontier" — SHIPPED (campaign complete)

> 4 features, 4 parallel Opus builders + orchestrator integration, 6 commits.
> Gates: service 70 modules / 1605 tests / 0 fail (batch-5 1480 → +125);
> web tsc clean, next build PASS, vitest **832/832 fully green**.

## Commits
| Commit | Feature |
|---|---|
| `a4ca065` | (docs) DESIGN-BATCH-6 |
| `32a4638` | Emotion/Voice Algebra (merged) — residual kill-switch gate, basis, derive endpoint, derived rung, rack UX |
| `e608337` | Score View — Track/Region/ScoreEditor primitives, offset regions ↔ [tag] grammar, edit transforms |
| `bf9deef` | Segment Casting Board — segment serve + re-splice, live seconds bar, audition-recipe coherence |
| `772f968` | Engine Seam — SpeechEngineClient + ServerEngine + capability probe + /benchmarks diagnostics |
| (last) | batch-6 reports + summary + campaign close-out |

## Orchestrator integration performed
- SCORE's 8-line mount applied to PlaygroundConsole (solo-mode collapsible score block).
- Accepted CASTING's ownership note (web/app/api/ingest/** proxies — uncontested).

## The honest activation story (Arm box required)
Emotion Algebra ships fully built but GATED: `python -m service.tools.emotion_residuals`
must run on a box with real embeddings (≥2 multi-slot speakers). Mean same-emotion
cross-speaker cosine < 0.15 → the feature dies (by design, in a day, not a quarter).
Until then every derive returns a named 422/501 and the rack shows the refusal verbatim.

## Notable
- SCORE found a real grammar asymmetry (digit-bearing emotion slots legal but
  tag-unaddressable) — refused out loud, not dropped.
- CASTING made edits withdraw stale audition recipes — the re-splice → audition loop can
  never audition dead audio.
- ALGEBRA excluded `_basis.safetensors` from the roster glob — it would have become a
  phantom Character.
- WASM: no `fragment` request kind — a punch-in fragment is wire-identical to a pinned solo
  request; a conformance test covers it instead of a no-op discriminant.

## Deferred
- Algebra: demand-driven autofill (step 5), blind A/B quality bar (step 6), character
  blending, pack origin field travel.
- Score: multi-lane ScriptLine stacking (Track/Region are ready), reuse on share surfaces.
- Casting: cross-recording pooling (corpus is the seam), Coverage-Coach planning.
- WASM: the actual local engine (weights export, ONNX/WebGPU runtime, worker inference).
