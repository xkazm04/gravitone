---
slug: a-picker-for-every-hand
type: perfect/direction
context: "[[TTS Playground]]"
lens: ux
size: S
status: shipped
proposed: 2026-08-06
accepted: 2026-08-06
shipped: 2026-08-07
commit: 443bf47
---
## What & why
The emotion wheel is a hard-coded 440×440 px grid (overflows every phone); per-voice availability is conveyed ONLY by dimming + hover tooltips (invisible on touch and to screen readers); no keyboard navigation between spokes; no announcement when a span is applied. Make the picker responsive, keyboard-navigable with listbox semantics, availability stated in text, insertions announced via live region.

## Evidence
- Fixed dims `h-[440px] w-[440px]`, `R = 150` (`EmotionPicker.tsx:18, 107`), inside `p-8` panel.
- Tooltip-only availability (`EmotionPicker.tsx:137`, `PlaygroundConsole.tsx:1480`).
- Plain buttons in `role="dialog"`, no roving focus — prior art exists in the character rail (`PlaygroundConsole.tsx:611-626`).
- ScoreEditor already has a live region (`ScoreEditor.tsx:462-464`); the primary path has none.

## Acceptance criteria
- Usable at 375 px viewport width (no horizontal overflow, touch targets ≥ 44 px).
- Full keyboard path: arrows between spokes, Enter applies, Escape closes (existing focus trap kept).
- Availability readable without hover (text/badge), and exposed to assistive tech.
- Applying an emotion announces via live region ("wrapped 5 words in excited").

## Risks / non-goals
- Keep the radial identity — responsive ≠ replace with a plain list on desktop.
- Coordinates with [[one-emotion-model]] (onPick creates regions) — same builder wave, sequenced brief.

## Build record
Builder P-B → 6eb311a, picked as **443bf47**. Wheel measures both axes, clamps to 440, compact mode <380px (44px discs, status folds into hub); arrows walk the ring with wrap + Home/End; Enter deliberately unhandled (spokes are real buttons — a second activation path could only disagree with the browser). Availability in the accessible NAME + ✓/+ glyph. `wrappedAnnouncement` in shared.ts fills the real gap: success was silent (refusals already announced). 375px test asserts geometry directly (spoke center + half-width inside box, both axes). Builder falsified 2 brief claims (visible availability text + record link already existed; the gaps were a11y names + touch). Verdict: merge.
