# REPORT — ALGEBRA (Emotion/Voice Algebra, merged), Batch 6

> Saved by the orchestrator from the builder's inline report.

**Status: H1 done, all gates green.**

Service (new): `service/tools/emotion_residuals.py` (residual gate: layout/flatten math,
per-emotion pairwise cosine, go/no-go/inconclusive/no-data verdicts; degrades named without
safetensors), `service/emotion_basis.py` (unit directions, leave-one-speaker-out MEDIAN
alpha, coherence gate, _basis.safetensors + _basis.json, tensors-before-manifest). Edited
`voices.py` (Voice origin/derived_from, EmotionMap carrying its derived set,
POST …/emotions/{e}/derive with basis OR named-donor source through create_voice's exact
staging discipline, manifest recorded/derived/unrecorded, demand kept alive,
_basis.safetensors EXCLUDED from the roster glob — would have become a phantom Character)
and `emotions.py` (derived rung; a derived hit returns fell_back=True so demand keeps
firing; app.py untouched).

Web: EmotionRack `derive from…` + lazy roster donor picker, violet `derived · from <donor>`
badge (never "recorded"), promote-to-recording, verbatim amber refusal chip; derive proxy
route; `_data/characters.ts` gained origin/derived_from/deriveVoiceReq/deriveVoice.

Tests: 252 targeted + FULL service suite 1605 OK; tsc clean; full vitest 832/832.

## The honest answer (activation requires the Arm box)
The gate cannot measure anything here — no safetensors, no real embeddings; today it prints
`VERDICT no-data`. On the Arm box: (1) `python -m service.tools.emotion_residuals` over a
registry with ≥2 multi-slot speakers — if mean same-emotion cross-speaker cosine < 0.15 the
feature DIES there; (2) `python -m service.emotion_basis`; (3) derive. Until (1) says go,
every derive is a named 422/501.

Hooks: none.
