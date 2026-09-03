---
slug: registry-read-cache
type: perfect/direction
context: "[[Voice & Emotion Library]]"
lens: optimization
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 4ab9b8c
---
## What & why
emotion_map → list_characters → full _load_meta + directory glob on EVERY /v1/speak, emotion-addressed TTS call, and per character per /v1/performance — JSON parse + disk glob in the synthesis hot path of a CPU-bound box. Cache the assembled registry keyed on _meta.json + voices-dir mtime, invalidated by the mutate helper.
## Evidence
voices.py:241, 201, 172; app.py:641; voices.py:224 (all_demand read per list).
## Acceptance criteria
- repeated resolutions hit cache (test: one disk read for N calls)
- any mutation (CRUD, pack import, ingest commit) invalidates
- behavior identical (same objects/fields)
## Risks / non-goals
mtime granularity: also bump an in-process generation counter on mutate. Depends on [[atomic-voice-registry]] (same builder, ordered).
## Build record
Round 2 wave 1, 2026-07-13. Opus builder; Director-reviewed; gates green (113 unittests + tsc). 4ab9b8c.
