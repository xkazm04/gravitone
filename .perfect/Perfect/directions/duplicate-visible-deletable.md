---
slug: duplicate-visible-deletable
type: perfect/direction
context: "[[Character & Voice Management]]"
lens: feature
status: shipped
size: M
proposed: 2026-07-29
accepted: 2026-07-29
shipped: 2026-07-29
commit: f7e1ee5
---
## What & why
Round 7 deliberately tolerates two voices on one emotion — "both stay in the roster; invisible is undeletable" — precisely so a user can remove one. The rack disagrees: it builds one row per scale emotion and takes the first match, so the shadowed voice has no row, no id and no remove button. Coverage counts distinct emotions, so nothing even hints it exists. The API tolerates the duplicate to make it fixable and the UI is the reason it is not.

## Evidence
- `web/app/voices/_data/characters.ts:327-337` — `voice: character?.voices.find((v) => v.emotion === id) ?? null`, one slot per scale emotion, first match wins. (Director-verified.)
- `service/voices.py:470-492` — `_by_emotion` tolerates duplicates, picks the first in scale order, and logs a warning naming BOTH voice ids; the doctrine comment is explicit that invisible means undeletable.
- `service/voices.py:541-545` — the backend pre-sorts voices by scale order and `coverage` counts `len(set(...))`, so the rack happens to display the same speaking voice the engine uses — it mis-attributes nothing, it just hides the other one.
- `EmotionRack.tsx:146-147` — removal is per-slot, so there is no path to the shadowed voice.

## Acceptance criteria
- A slot holding more than one voice shows all of them and marks which one actually speaks (the backend already decides this deterministically — surface its answer, do not re-derive one).
- Each voice in such a slot can be removed individually.
- An ordinary one-voice slot is visually unchanged.
- Deleting the shadowed voice resolves the duplicate and leaves the speaking voice untouched — covered by a test.

## Risks / non-goals
- Do not "fix" duplicates by hiding or auto-merging them; round 7 chose tolerance deliberately and the user must stay in control of which one goes.
- Non-goal: a re-slot/rename flow for the shadowed voice (the backend supports re-slotting, but that is its own direction).

## Build record
Builder V2. `voice: character?.voices.find(v => v.emotion === id) ?? null` —
first match wins, so a duplicated emotion slot hid the shadowed voice entirely:
no row, no id, no remove button, and coverage counts distinct emotions so the
numbers hid it too. `Slot` now carries `voices: Voice[]`; `buildSlots` extracted
as a pure function and tested.
