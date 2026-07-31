---
slug: firstclass-custom-emotions
type: perfect/direction
context: "[[Character & Voice Management]]"
lens: feature
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 1b836d1
---
## What & why
Custom-emotion characters get lied to twice: CoverageBar renders exactly 8 base pips while the count says 9/11 (CharacterTable.tsx:22 vs backend effective scale); GuidedRecorder hardcodes /8, never offers custom slots, declares complete at 8/8 with custom slots empty (GuidedRecorder.tsx:135,190). Derive both from the character's real scale.
## Acceptance criteria
- coverage pips = actual scale (custom included)
- recorder denominator + auto-advance cover custom slots
- deep-link ?record=<custom> works
## Risks / non-goals
No new custom-emotion art (procedural sigils stay).
## Build record
Round 3 wave 2, 2026-07-13. Director-reviewed; tsc green. Commit 1b836d1.
