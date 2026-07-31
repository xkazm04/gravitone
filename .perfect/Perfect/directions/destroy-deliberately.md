---
slug: destroy-deliberately
type: perfect/direction
context: "[[Character & Voice Management]]"
lens: ux
status: shipped
size: M
proposed: 2026-07-29
accepted: 2026-07-29
shipped: 2026-07-29
commit: 9613db6
---
## What & why
Deleting a voice, a character, or a bulk selection are the only actions on this surface with no confirmation — while the consent gate and the import rename both use a native confirm. Deleting a cloned voice destroys an embedding the user may not be able to re-record. The failure copy is also thinner than the backend it reports: a partial delete now returns a sanitized 500 that specifically means the voice is INTACT, and the UI says only "delete failed". Both optimistic paths roll back by re-fetching rather than from a snapshot, so if that second call also fails the wrong row stays on screen under a second error.

## Evidence
- `web/app/voices/[characterId]/_variants/EmotionRack.tsx:146` (voice), `web/app/voices/_variants/CharacterTable.tsx:347` (character), `:149-156` (bulk) — no confirmation on any.
- Contrast `CharacterTable.tsx:158` and `CharacterVoices.tsx:45` (consent) and `:189` (import rename), which all gate.
- `service/voices.py:997-1002` — the partial-delete 500 means "the Voice is unchanged rather than half-deleted"; `characters.ts:385-396` renders "delete failed". `profile/MyVoices.tsx:53` gets this right ("— it is still usable").
- `characters.ts:277,288` — rollback is a full `refresh()`; `web/app/keys/_variants/data.ts:82-101` keeps a snapshot for exactly this reason and is the rule's cited example in `.claude/CLAUDE.md:66-68`.
- `characters.ts:276` "update failed" / `:287` "delete failed" — neither names the surviving state.
- `characters.ts:455` — `useVoicePreview`'s bare `catch {}` discards the backend detail entirely, showing only "preview failed".

## Acceptance criteria
- The three destructive paths confirm, naming what will be destroyed.
- Rollback copy states the true surviving state, in the shape the repo's own canonical example uses.
- Rollback restores from a snapshot rather than depending on a second network call succeeding.
- The preview failure carries its reason instead of swallowing it.

## Risks / non-goals
- A confirmation on a bulk delete must name the count, not just say "are you sure" — the point is that the user knows what they are about to lose.
- Non-goal: an undo/trash mechanism, or changing what the backend deletes.

## Build record
Builder V3, forked from a main already carrying the other four so it had
nothing to merge. All three destructive paths now ask, with the question
builders (`deleteVoiceQuestion`, `deleteCharacterQuestion`, `bulkDeleteQuestion`)
in the data layer so both surfaces and the tests share one wording. The bulk
question names the count AND the names ("Delete 2 characters and 3 voices?"),
truncating past five.

The failure copy is split by what the backend actually guarantees, which the
Director verified at `service/voices.py:1035-1057` rather than taking on trust:
`delete_character`'s 500 is genuinely PARTIAL — `_unlink_then_forget` commits
the rows whose embeddings unlinked and the character row is popped only when
nothing failed — so "still in your roster; some of its voices may already have
been deleted" is true, and "nothing happened" would not be. A 404 keeps the
optimistic removal, because restoring a row for something absent from the
registry would itself be the false state.

Rollback is from a snapshot in both `patchCharacter` and `deleteCharacter`, in
the `revokeKey` shape. Director teeth-check: swapping the snapshot back for
`await refresh()` turns "restores the row from a snapshot even when the re-read
fails too" red.

`useVoicePreview` routes its non-OK response through `throwDetail` and exposes
`failedReason`; the bare `catch {}` is gone. In-flight gates added on every
delete path (ref for the same-tick double-click, mirrored to state for the
disabled button).

Also reported: the worktree junction I created pointed at a non-existent path
(relative `mklink /J` target resolving against CWD — the exact mistake already
recorded in memory). V3 repaired it locally and flagged it.
