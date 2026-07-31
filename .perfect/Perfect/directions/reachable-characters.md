---
slug: reachable-characters
type: perfect/direction
context: "[[TTS Playground]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 11e3465
---
## What & why
The solo-mode character rail is hard-capped at ten with no "show all" (Director-verified), so a user who clones an eleventh voice simply cannot select it in solo mode — while script mode's `<select>` lists every character, making the app inconsistent with itself about what exists. The composer likewise enforces nothing against the 8000-char server cap, so the limit is learned by failure. And the emotion picker claims to be a modal dialog without managing focus.

## Evidence
- `web/app/playground/_variants/PlaygroundConsole.tsx:517` — `characters.slice(0, 10).map(...)`, no overflow affordance.
- `:570` — script mode's `<select>` renders the full roster: same data, two different truths.
- `service/app.py:656` — 8000-char server cap; `web/lib/backend.ts:146-159` — 128 KB proxy body cap; no `maxLength` or counter on the composer (`:554`).
- `EmotionPicker.tsx:55` — `role="dialog" aria-modal="true"`; `:39-44` handles Escape only, no focus trap, no focus return.
- `:520` — rail buttons carry `aria-pressed` but there is no roving tabindex / arrow-key navigation.
- `:234-244` — removing a script line never compacts `lineRefs.current` (`:85`), leaving stale trailing slots.
- `EmotionPicker.tsx:37-38` — hand-rolled mounted flag duplicating `lib/useMounted.ts:17`.

## Acceptance criteria
- Every character is reachable in solo mode (show-all/scroll/search — builder's choice, documented); solo and script mode agree on the roster.
- The composer communicates and enforces the real limit before submit rather than after a failed request.
- The emotion dialog traps focus while open and returns focus to its trigger on close.
- The character rail supports keyboard navigation (roving tabindex + arrows) with `aria-pressed` preserved.
- `lineRefs` compacts on line removal; `EmotionPicker` uses `useMounted` instead of its own flag.

## Risks / non-goals
- The rail's visual density is a deliberate design choice — adding overflow must not turn it into a wall of buttons; keep the shipped look.
- Non-goal: redesigning the character rail or adding character management actions here (that is Character & Voice Management's context).

## Build record
Builder W2. Rail overflow (documented choice): keep ten visible so the density stays as designed, then a `+N more` chip expanding into a `max-h-64` scrolled panel with a filter input once the roster exceeds ten; the selected Character is always drawn even when it sorts past the preview. Solo and Script now agree on the roster. Limits enforced BEFORE submit via one pure `composerLimit()` in `shared.ts` mirroring `service/app.py` (8000 chars, 64 lines) and `web/lib/backend.ts` (128 KB): the counter states the ceiling and colours as it approaches, Generate is gated with a title saying why, per-line errors name the line. Deliberately NO `maxLength` — silently truncating a paste would be its own lie. Emotion dialog takes focus on open, wraps Tab both directions, returns focus to its trigger on close. Rail keyboard nav: roving tabindex + arrows/Home/End, `aria-pressed` preserved, selection still only via Enter/Space. `lineRefs` compacts on line removal — it was off-by-one after ANY removal, putting emotion-tag insertion in the wrong row (a real bug the scout only saw as untidy bookkeeping).

**Builder pushback, accepted**: the direction said to replace EmotionPicker's hand-rolled flag with `lib/useMounted`. The builder refused and was RIGHT — `useMounted` returns a ref that is `true` from the first render (its job is catching unmount during an await), so using it as the portal guard would call `createPortal(document.body)` during SSR. It added `useClientReady()` beside it in the same file instead. Director verified `useMounted`'s implementation before accepting.

**Director review**: gates on main — tsc clean, 76/76 across 10 files (incl. new EmotionPicker focus-trap and `shared.test.ts` limit tests), `npx next build` compiles and prerenders every route. MERGED.
