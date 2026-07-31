---
slug: atomic-voice-registry
type: perfect/direction
context: "[[Voice & Emotion Library]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 42f1bb9
---
## What & why
_save_meta is plain write_text, no lock, no atomic replace; every mutating endpoint does unguarded load→mutate→save; packs import does the same on the same file. Concurrent clones silently clobber each other's metadata. One lock + tmp-then-replace + a mutate_meta() helper used by voices CRUD and packs.
## Evidence
voices.py:149-151; voices.py:403/448, 457/465, 477-480; packs.py:151-187.
## Acceptance criteria
- all _meta.json writes locked + atomic (tmp replace)
- one shared mutate helper; packs uses it
- concurrent-clone regression test
- crash mid-write can't truncate the registry
## Risks / non-goals
No DB migration; single-process lock only (replicas each own their meta reads — fine, mutations are studio-driven).
## Build record
Round 2 wave 1, 2026-07-13. Opus builder; Director-reviewed; gates green (113 unittests + tsc). 42f1bb9 (+9fa3390 ingest through mutate_meta, Director).
