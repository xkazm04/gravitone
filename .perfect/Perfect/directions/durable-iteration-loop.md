---
slug: durable-iteration-loop
type: perfect/direction
context: "[[TTS Playground]]"
lens: feature
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: ed18a56
---
## What & why
Round 2 made takes durable; the work that produced them still isn't. A refresh restores the take log and wipes the composer — text, the whole multi-line script, expression settings, mode, selected character. And the segment ribbon reports "sad → nearest emotion" without any way to act on it: re-running a take means retyping the prompt, even though every take already stores the text, character and expression that produced it. Closing that loop turns the ribbon from a receipt into a working iteration cycle.

## Evidence
- `web/app/playground/_variants/PlaygroundConsole.tsx:76-86` — `text`, `script`, `expr`, `mode`, `charId` are plain `useState`.
- `:147-163` — takes restore from IndexedDB on mount (`lib/takeStore.ts:70`), so the durability mechanism already exists and is proven.
- `web/app/playground/_variants/shared.ts:42-43` — takes carry `text`, `characterId`, `expr`.
- `:807-840` — the segment ribbon renders the fallback report; the only action on it is a `record →` deep link.
- `:257-268` — switching to script mode seeds a canned two-line demo, discarding composed solo text.

## Acceptance criteria
- Composer state (text, script lines, expression, mode, selected character) survives a refresh, using the same durability approach as takes — one mechanism, not a second one.
- A single action on a take loads it back into the composer (text, character, emotion tags, expression) ready to re-run.
- Solo↔script switching carries the composed text across instead of clobbering it with the canned demo.
- Restored state is validated on load: a persisted character id that no longer exists must not silently select nothing or crash the rail.
- Nothing regresses in the take log: object-URL revocation (`:359`, `:167-171`) and the 50-take prune (`takeStore.ts:80-84`) keep working.

## Risks / non-goals
- Persisting on every keystroke will thrash IndexedDB — debounce, and state that choice in the report.
- Non-goal: server-side composer sync or multi-device state; local durability only.
- Non-goal: version history of composer states.

## Build record
Builder W2. ONE mechanism as required: new `lib/playgroundDb.ts` owns the playground's IndexedDB, with takes and composer as two stores (v1→v2 upgrade is additive — existing takes survive). Debounce is **800ms of quiet**, and saving only begins after the restore has settled so an empty composer can never overwrite a stored one. Validation is two-stage: `sanitizeComposer` (shape/mode/slider clamps/line ids; returns null when nothing is worth restoring, so a fresh composer is never overwritten with emptiness) and `reconcileCharacters` (roster-dependent — a deleted Character is repointed AND reported, never silently re-voiced or left unselected). Character selection now decided in exactly one effect. `↺ reuse` on each take loads text (or the whole directed script), Character, tags and expression back into the composer and scrolls to it, through the same reconciliation. Solo→Script carries composed text into line 1 (canned demo only when there is nothing to carry); Script→Solo fills an empty solo composer from the active line. Take-log invariants intact (object-URL revocation, 50-take prune).

**Cross-builder catch worth recording**: `takeStore` swallowed ALL failures, which silently made W1's just-shipped "this take could not be saved" / "could not be restored" banners UNREACHABLE and turned a failed restore into a false empty state. W2 found and fixed it. This is the value of sequencing the two playground builders instead of running them in parallel.

Stated limit, honestly: a change in the last 800ms before a tab closes is lost — IndexedDB is async and there is no honest synchronous `pagehide` flush.

**Director review**: read `sanitizeComposer`/`reconcileCharacters` in full — the "returns null when nothing is worth restoring" guard and the report-don't-silently-repoint behaviour are exactly the acceptance criteria, and the clamps make a corrupted store non-fatal. Gates on main: tsc clean, 76/76, next build green. MERGED.
