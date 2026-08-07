---
slug: one-emotion-model
type: perfect/direction
context: "[[TTS Playground]]"
lens: ux
size: M
status: shipped
proposed: 2026-08-06
accepted: 2026-08-06
shipped: 2026-08-07
commit: 47c2747
---
## What & why
Every emotion-insertion path (chip row, radial wheel, script-mode inserts) stops splicing `[tag]` literals into the textarea and instead creates **regions** in the already-shipped structured model; the tagged string becomes derived output (`toTags`) regenerated on change, and free-text edits pass through `transformRegions` (shift/grow/clear-with-named-reason). The score surface is promoted out of `<details>` to the primary composer; the `[baseline]` chip becomes "clear region". A user can no longer corrupt markup they never hand-edit — this kills the backspace-corruption class the owner named.

## Evidence
- `wrapWithTag` caret trap: empty insert parks caret inside `[x]|[/x]` → one backspace makes `[x[/x]` (`web/lib/emotions.ts:50-58`).
- Literal splice handler `insertEmotion` (`PlaygroundConsole.tsx:681-700`); raw textarea `:1386-1390`.
- Working span model: `ScoreRegion`/`parseTags`/`toTags`/`transformRegions`/`regionProblem` (`shared.ts:274-488`), mounted but buried at `PlaygroundConsole.tsx:1443-1460`.
- `[baseline]` insertable from chips (`:1474`) but forbidden by `regionProblem` (`shared.ts:354-356`).
- Zero tests on `wrapWithTag`/`insertEmotion`.

## Acceptance criteria
- No insertion path writes tag literals; regions are the single emotion-application model in solo AND script mode (ScriptScore lanes).
- Backspace/cut/paste of picker-applied emotions can never yield a malformed tag; interior rewrites clear the region with a named reason (existing `transformRegions` rule).
- Wire + storage contracts unchanged: `/v1/speak` `{text}`, `/v1/performance` `{lines}`, `composerStore` round-trip, takes replay, shares/`RePerform`.
- `[baseline]` chip semantics = clear; the score is the primary surface, not opt-in.
- Insertion paths tested (today zero); score grammar-parity suite still green.

## Risks / non-goals
- Power users may still hand-type tags in raw mode — allowed; `parseTags` re-derives regions (lint is A3's job).
- Do NOT change the server grammar here (A3 owns the digit fix).
- Heavy shared-file overlap with [[spans-you-can-see]] and [[director-suggests-spans]] → sequenced builders.

## Build record
Builder P-A → d6a1df1, picked to main as **47c2747**. `applyEmotion`/`editPlainText` in shared.ts are THE application model (layered on parseTags/toTags/transformRegions/regionProblem); `wrapWithTag` DELETED with a do-not-reintroduce note; solo textarea replaced by ScoreEditor (promoted from `<details>`, ⌘↵ carried via onSubmit, imperative `ScoreEditorHandle.applyEmotion` for chips/wheel); script lanes derive plain words, edits via editPlainText, cleared regions announced aria-live; baseline chip = eraser. 18 new tests incl. every-single-char-deletion round-trip. Contracts unchanged, no composerStore version bump needed. Open risk (pre-existing): hand-typed literal brackets re-parse as tags on round-trip; lint warns, doesn't escape. Console now 1950 LOC — split deferred deliberately. Director gates on main: tsc clean, 308 playground web tests. Verdict: merge, no notes.
