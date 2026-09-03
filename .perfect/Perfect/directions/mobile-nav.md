---
slug: mobile-nav
type: perfect/direction
context: "[[App Shell & Landing]]"
lens: wildcard
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: edc0f28
---
## What & why
Signed-in mobile users get no navigation (hidden md:flex, no hamburger, StudioDark.tsx:56); AppFrame has the same gap.
## Acceptance criteria
- mobile menu with Playground/Voices/Keys on both shells
- keyboard/aria correct
- desktop unchanged
## Build record
Round 3 wave 2, 2026-07-13. Shared MobileNav component (hamburger + glass dropdown, aria/Escape/focus handled) wired into StudioDark + AppFrame. tsc green. Commit edc0f28.
