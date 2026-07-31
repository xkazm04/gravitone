---
slug: show-consent-provenance
type: perfect/direction
context: "[[Character & Voice Management]]"
lens: ux
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 2a0d832
---
## What & why
Rounds 1-2 wrote consent receipts into every new voice and pack imports store imported{from,at} provenance — the studio displays none of it. Web Voice type omits consent entirely. Add consent badge per voice (rack + roster) and provenance/signature status on pack-imported characters.
## Evidence
data.ts:6-15 (consent omitted); packs.py:180 (imported{from,at} stored, unread); voices.py:55,181,366 (consent served).
## Acceptance criteria
- consent badge in rack + roster rows (distinct "no receipt" legacy state)
- pack provenance + signature status on character detail
- no layout regressions; tsc green
## Risks / non-goals
No consent editing/migration UI.
## Build record
Round 3 wave 1, 2026-07-13. Director-reviewed; gates green (143 tests + tsc). Commit 2a0d832.
