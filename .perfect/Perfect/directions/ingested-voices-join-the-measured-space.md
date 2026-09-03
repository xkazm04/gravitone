---
slug: ingested-voices-join-the-measured-space
type: perfect/direction
context: "[[voice-cloning-ingest-pipeline]]"
lens: feature
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 9753ade
---
## What & why
Measured Emotion Space never reaches studio-created voices: voices.create_voice stamps prosody + label_check; ingest.commit's registry entry has neither, so every resolve(..., prosody=prosody_map(cid)) silently degrades to the static prior for characters made via the PRIMARY creation path. Paid-for feature, undelivered where it matters most.

## Evidence
- voices.py:1291-1292 stamps; ingest.py:1775-1789 doesn't; app.py:794/:2602/:2750 resolve with empty map for ingested characters
- batch-1 E-SPACE report: "Untouched as required: service/voices.py, service/ingest.py"

## Acceptance criteria
- ingest.commit (and rederive's replace path) stamp prosody/label_check via the SAME helpers create_voice uses — no forked implementation.
- A studio-committed voice observably resolves through measured prosody (test through the real resolve path, not field presence — round-6 wiring lesson).
- Existing ingested voices: documented upgrade path (rederive stamps on rebuild, or a one-shot backfill — builder recommends, Director decides).
- Tests: commit path, rederive path, resolve-through.

## Risks / non-goals
prosody measurement may need the stem wavs at commit time — they are present in the workdir then; do not add a post-hoc network call.

## Build record
(pending)
Build record: I-B done. voices.stamp_measured(row, wav, emotion, cid) extracted — one entry point, ordered halves, called BEFORE registration; ingest.commit + rederive stamp via it. Upgrade path: rederive-on-rebuild only (backfill impossible — legacy stems GC'd, embeddings unprobeable; docstring says so). Resolve-through tests, mutation-checked by execution (4/5 fail with stamping deleted). Merged 9753ade.
