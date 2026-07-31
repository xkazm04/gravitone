---
slug: collision-gets-an-answer
type: perfect/direction
context: "[[Character & Voice Management]]"
lens: ux
status: shipped
size: M
proposed: 2026-07-29
accepted: 2026-07-29
shipped: 2026-07-29
commit: 048a20f
---
## What & why
Three creation paths can hit round 7's built-in-collision 409 and none of them branches on it. The quick clone derives the character name from the FILENAME, so dropping `mary.wav` is a guaranteed 409 — a generic rose banner, no way to pick another name, and the chosen file is discarded so the user must re-pick it. The only 409 handler in the tree is the pack import's `window.prompt("A character with this id already exists")`, which is now false copy for a built-in collision and throws away the backend detail that names the built-in. Renaming or tagging a premade character is offered on every row, optimistically painted, then 409'd and snapped back.

## Evidence
- `service/voices.py:410-433` — `reject_builtin_collision` 409s with a message naming the built-in; ids at `:46-53` are ordinary first names.
- `web/app/voices/_variants/CharacterTable.tsx:157-177` — quick clone takes the name from `f.name.replace(/\.[^.]+$/,"")`; the error lands in the generic banner at `:217` and the file is not retained.
- `CharacterTable.tsx:186-192` — the pack-import 409 handler; `body.detail` is read at `:187` and used only on the cancel branch (`:191`).
- `web/app/voices/new/page.tsx:249-270` — branches on 429 only; a commit-time 409 falls to the generic `SET_ERROR` after a full record-and-review.
- `new/page.tsx:743` already duplicates `_slug` correctly, so the UI CAN compute the colliding id locally and does not.
- `service/voices.py:1017-1023` — `patch_character` now 409s built-ins and 404s an id with no voices; `CharacterTable.tsx:318` (rename) and `:342` (tags) have no `category` guard, and `characters.ts:268` paints the change optimistically first.
- `service/voices.py:942-947` — the slot-collision 409 deliberately names the holding `voice_id`; the UI renders it as raw text.

## Acceptance criteria
- A built-in collision is caught before the user's work is discarded — at minimum the quick clone keeps the file and offers another name.
- The pack-import prompt uses the backend's own message rather than asserting something false.
- Actions that will 409 on a built-in are not offered on built-ins, so nothing is optimistically painted and then snapped back.
- A slot-collision message points at the voice it names rather than printing an id the user must hunt for.

## Risks / non-goals
- Do not duplicate the built-in list into the web app if it can be fetched or derived — a fourth copy of a server constant is how this class of bug starts (see the slug drift in the sibling direction).
- Non-goal: changing the collision policy itself, which round 7 settled.

## Build record
Builder V2 (+ Director repair `f04a3c2`). A quick clone takes its character
name from the FILENAME, and the built-in ids are ordinary first names, so
dropping `mary.wav` was a guaranteed 409 — which discarded the chosen file and
printed a generic banner. Now the file is retained, the backend's own detail is
shown, a rename re-sends without re-asking for consent already attested, and a
slot collision links the voice it names instead of printing a bare id.

Director note: my union of the two builders' `CharacterTable.test.tsx` left the
file unparseable, which vitest reported as two failing TESTS. I spent an hour
hunting a component interaction that did not exist. See the session note.
