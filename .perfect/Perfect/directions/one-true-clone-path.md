---
slug: one-true-clone-path
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: wildcard
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 9e3a15b
---
## What & why
Three divergent clone pipelines ship different quality: ingest sovereign denoises (highpass+afftdn+loudnorm) but create_voice and clone_test.sh skip afftdn, and the cloud path skips loudnorm after isolation; commit clones stems flagged ineligible. One canonical cleanup+export module shared by all paths; enforce min_stem eligibility at commit.
## Evidence
ingest.py:167 vs voices.py:338 vs clone_test.sh:25; ingest.py:305; ingest.py:407-419; voices.py:343-344 (3s vs "5 seconds" message).
## Acceptance criteria
- single cleanup function used by ingest (both modes), create_voice, clone_test.sh
- commit rejects ineligible stems server-side
- validation message consistency fixed
- behavior documented in README
## Risks / non-goals
No change to embedding/export format.
## Build record
Wave 2, 2026-07-13. Opus builder; Director-reviewed; gates green (compileall + 73 unittests). 9e3a15b. Note: export_stems in-process serializer is verified by load-back + falls back to the proven pocket_tts export-voice CLI; needs one integration run on a box with the model.
