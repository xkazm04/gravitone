---
slug: performance-composer
type: perfect/direction
context: "[[TTS Playground]]"
lens: feature
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 4fa426c
---
## What & why
Backend runs 64-line multi-character scripts in one call (/v1/performance) but the playground is hard-locked to one character per take and no proxy exists. Line-based script composer: per-line character picker + emotion-tagged text, one Generate → single radio-play take with the segment ribbon showing who spoke what.
## Evidence
app.py:621 (/v1/performance); PlaygroundConsole.tsx:191 (single character_id); no /api/performance route.
## Acceptance criteria
- /api/performance proxy (headers forwarded incl. X-Performance-Report)
- composer UI for ≥2 characters, per-line emotion tags
- take log/transport/share work identically for performance takes
- per-line fallback substitutions visible in the ribbon
## Risks / non-goals
No streaming for performances; premium scope (performance) auth respected.
## Build record
Round 2 wave 1, 2026-07-13. Opus builder; Director-reviewed; gates green (113 unittests + tsc). 4fa426c.
