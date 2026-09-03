---
slug: working-ctas
type: perfect/direction
context: "[[App Shell & Landing]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: e10ca52
---
## What & why
Hero CTA anchors to on-page teaser not /playground (StudioDark.tsx:92); Read-the-API anchors to features grid (:95); teaser Generate has no onClick (:165); orphaned NAV config with missing #pricing (content.ts:62-67).
## Acceptance criteria
- hero CTA → /playground
- API CTA → real destination
- teaser Generate works or removed
- no orphaned NAV/anchors
## Build record
Round 3 wave 1, 2026-07-13. Director-reviewed (verified remote URL for API_DOCS_URL; README matrix now truthful). tsc green. Commit e10ca52.
