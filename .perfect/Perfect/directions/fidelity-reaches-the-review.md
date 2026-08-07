---
slug: fidelity-reaches-the-review
type: perfect/direction
context: "[[voice-creation-studio]]"
lens: feature
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 1e91b4e
---
## What & why
The pipeline measures per-stem identity explicitly "for the review screen" and the review screen never shows it — the number dies at the TS type boundary. Post-commit, identity/identity_reason/replaced are dropped too: an extend-mode commit that OVERWRITES an existing voice says nothing. Which labels came from the cheap classifier vs a paid escalation is also invisible.

## Evidence
- ingest.py:1524-1539 identity per stem ("the number the review screen shows"); :1825-1833 identity/identity_reason/replaced on created
- machine.ts:34 Stem no identity; :68 Created = {voice_id, emotion}; page.tsx:897-905 chips only
- machine.ts:50 model/escalation declared; SegmentBoard renders neither

## Acceptance criteria
- Identity renders per stem on the review ledger (graceful absence when unmeasured).
- Complete screen shows identity, identity_reason, and names overwrites plainly ("replaced the previous X voice").
- SegmentBoard badges classifier-vs-escalation per segment.
- Types extended, not forked; machine tests updated.

## Risks / non-goals
Non-goal: thresholds/gating on the number — display + honesty only this round.

## Build record
(pending)
