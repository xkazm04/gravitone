---
slug: create-flow-state-machine
type: perfect/direction
context: "[[Voice Creation Studio]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 99313a6
---
## What & why
488-line component, 20 state hooks, three overlapping character identifiers, status→phase mapping duplicated across two pollers, inconsistent resets, and a drift bug: the optimistic job skeleton always writes CLOUD step labels even for sovereign scans. Consolidate into a reducer with one status→phase map, one reset, one character identity; fix the sovereign-steps bug.
## Evidence
page.tsx:31-55 (hooks), :73-76 vs :91-102 (dup mapping), :120-123 vs ingest_api.py:41-54 (drift), :173-176 vs :178-181 (resets).
## Acceptance criteria
- single reducer/state machine; one status→phase function shared by both pollers
- sovereign scans show sovereign step labels from the server, never faked
- both resets behave identically
- no behavior regressions (all phases reachable)
## Risks / non-goals
Pure restructure + bug fix; no visual changes.
## Build record
Round 2 wave 1, 2026-07-13. Opus builder; Director-reviewed; gates green (113 unittests + tsc). 99313a6.
