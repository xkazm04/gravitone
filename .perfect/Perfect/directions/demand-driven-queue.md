---
slug: demand-driven-queue
type: perfect/direction
context: "[[Character & Voice Management]]"
lens: wildcard
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: bf3a1ef
---
## What & why
Demand telemetry exists to answer "record this next" (demand.py:5-6) and the rack shows per-slot heat, but the roster shows nothing (Character.demand fetched+typed, unused, data.ts:31). Surface unmet demand per character, sortable, one click into the recorder at the hottest missing emotion.
## Acceptance criteria
- roster shows unmet-demand heat
- sortable by it
- click-through opens recorder at hottest missing emotion
- zero-demand rosters unchanged
## Risks / non-goals
No demand editing/reset UI.
## Build record
Round 3 wave 2, 2026-07-13. Director-reviewed; tsc green. Commit bf3a1ef.
