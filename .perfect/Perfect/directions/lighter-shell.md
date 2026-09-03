---
slug: lighter-shell
type: perfect/direction
context: "[[App Shell & Landing]]"
lens: optimization
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: c268ff8
---
## What & why
Six font families load, three unused on landing (layout.tsx:13-18, globals.css:8-10); Equalizer duplicated (StudioDark.tsx:23-35 = HeroMicDemo.tsx:23-35); aurora/grain/eq animate continuously.
## Acceptance criteria
- only used fonts load
- one Equalizer
- background animations pause off-viewport
- visuals unchanged
## Build record
Round 3 wave 1, 2026-07-13. Director-reviewed (verified remote URL for API_DOCS_URL; README matrix now truthful). tsc green. Commit c268ff8.
