# Gravitone — deferred follow-ups (waves 1–4, 2026-07-10)

Deliberately descoped during the business_visionary implementation waves.
Each needs a product/pricing decision or a bigger engine than the wave scoped.

## From emotion-coverage-loop (wave 4)

- **Custom emotion vocabulary as paid slots** (idea cd02e93b, second half).
  The tag grammar + slot model already accept arbitrary emotion names, and
  demand telemetry now counts non-scale requests (e.g. `[sarcastic]`) — the
  appetite data is accumulating. Selling per-character custom slots needs:
  pricing/entitlement model (the Firestore `plan` field is still inert),
  scale-extension UX in the rack, and web `EMOTIONS` list becoming dynamic.
- **Paid-tier gating of extended coverage** (idea fb8bd137, "beyond
  baseline+2 emotions"). Same blocker: no billing/entitlement enforcement
  exists anywhere yet. Guided capture shipped ungated.
- **Stem top-up + re-export** (idea fec200bd, second half). Appending new
  segments to an existing ingest stem and re-exporting the voice (instead of
  cloning a fresh recording into the slot) needs an ingest "extend stem" job
  mode in service/ingest.py. The Coverage Coach currently routes users to
  the guided recorder, which clones from a fresh take — good enough until
  stem-level fidelity matters.

## From character-packs (wave 5)

- **Pack gallery / marketplace** (all three ideas' second half): publishing,
  browsing, licensing and paid packs need hosting + payments + moderation —
  a product decision. The portable format (.gravichar) and export/import
  endpoints are done; a gallery is purely additive.
- **Keypair signing**: packs currently carry per-file sha256 (integrity,
  always verified) and optional HMAC via shared TTS_PACK_SECRET (team
  authenticity). Public distribution needs Ed25519 creator keys + a trust
  model.
- **License/creator fields** exist in the manifest but nothing fills them —
  add to the export UI when the gallery lands.

## From earlier waves

- **Streaming synthesis** (compat matrix ❌ row): whole-utterance responses
  only; a `/stream` endpoint would complete ElevenLabs drop-in parity.
- **Shadow mode / traffic mirroring** (idea 50debb27, descoped): replay a
  customer's live ElevenLabs traffic against Gravitone for A/B listening.
- **Community benchmark submissions**: /benchmarks invites PRs; an actual
  results-upload endpoint + moderation would grow the corpus faster.
- **Usage metering/billing ledger**: whole cluster was REJECTED in triage
  2026-07-10 — do not build without a new decision. Several shipped surfaces
  (per-key savings meter, plan upgrades) get sharper once it exists.
