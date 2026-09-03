---
slug: nearest-emotion-fallback
type: perfect/direction
context: "[[Voice & Emotion Library]]"
lens: feature
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 0537289
---
## What & why
Every miss collapses flat to baseline; a character with no baseline falls back to a nondeterministic dict-order pick, computed independently (possibly differently) from the manifest's fallback. Add an adjacency map (excited→happy→baseline, sad→calm→baseline, angry→excited→…, whisper→calm→…), resolve walks it, report the used emotion honestly, share the deterministic pick with the manifest.
## Evidence
emotions.py:104-106, :105; voices.py:368.
## Acceptance criteria
- misses resolve to nearest available per map, then baseline
- no-baseline fallback deterministic and identical in resolve + manifest
- X-Segments/report show true used emotion
- demand telemetry still records the REQUESTED emotion
## Risks / non-goals
Map is curated, not learned; no intensity/blends.
## Build record
Round 2 wave 1, 2026-07-13. Opus builder; Director-reviewed; gates green (113 unittests + tsc). 0537289.
