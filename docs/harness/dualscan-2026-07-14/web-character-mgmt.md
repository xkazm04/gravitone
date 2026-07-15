# Dual-lens scan — web-character-mgmt
> Files: 10 | Findings: 5 (crit 0 / high 1 / med 3 / low 1)
> Lenses: bug-hunter + code-refactor

## 1. Stale `?record=` deep-link re-fires on every character refresh and hijacks the recorder
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: state-corruption / effect-dependency
- **File**: `web/app/voices/[characterId]/CharacterVoices.tsx:22`
- **Scenario**: A user opens `/voices/x?record=angry`, then either (a) clicks "Next: Happy →" (`onSwitch`) inside the guided recorder, or (b) records a *different* emotion from the rack. The clone calls `addVoice → refresh()`, which replaces the `character` object. The `useEffect` with dependency `[character]` re-runs, re-reads the never-cleared `?record=angry` URL param, and calls `setRecording("angry")` — yanking the session back to "angry" or re-opening a recorder the user already left.
- **Root cause**: The deep-link intent is treated as a *derived value of `character`* (effect keyed on `[character]`) instead of a *one-time mount action*, and the URL param is never consumed/cleared. Every roster mutation triggers `refresh()`, so the intent replays indefinitely.
- **Impact**: Guided "walk to the next slot" flow is broken for anyone who arrives via a playground fallback link; the recorder repeatedly snaps back to the URL emotion or re-opens after being closed, making multi-emotion capture sessions unusable from a deep link.
- **Fix sketch**: Run the param read once on mount (`useEffect(..., [])` reading `character` via a ref, or gate with a `usedDeepLink` ref), and clear the param after applying it (`router.replace` / `history.replaceState` to strip `record`) so a later `character` change can't replay it.

## 2. Quick-clone file input never resets `value` — re-selecting the same file silently does nothing
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: silent-failure / edge-case
- **File**: `web/app/voices/_variants/CharacterTable.tsx:236`
- **Scenario**: A "quick clone" fails (backend 503, bad audio) and the user re-picks the *same* file to retry. The `<input type="file">`'s `value` still holds that path, so the browser fires no `change` event and `onFile` is never called — the retry appears to do nothing.
- **Root cause**: The `packRef` handler resets `e.target.value = ""` after use (line 229) but the `fileRef` handler at line 236 omits it. A file input only emits `change` when the selection differs from its current value.
- **Impact**: Retrying a failed clone (or cloning the same file into two characters) requires picking a different file or reloading; the UI looks frozen/unresponsive with no error, undermining trust in the clone action.
- **Fix sketch**: Mirror line 229 — append `e.target.value = "";` to the `fileRef` `onChange` handler so the same file can be selected again.

## 3. Blob URL leak in `useVoicePreview` — every preview allocates an object URL that is never revoked
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: resource-leak
- **File**: `web/app/voices/_data/characters.ts:350`
- **Scenario**: In a studio session an operator previews many voices across the roster and emotion racks. Each `preview()` does `URL.createObjectURL(await r.blob())` and assigns it to `audioRef.current.src`; the previous URL is orphaned. Neither `stop()`, `a.onended`, nor the unmount effect (line 369) ever calls `URL.revokeObjectURL`.
- **Root cause**: The audio element's blob URLs are treated as fire-and-forget. The retained `Blob` behind each URL is only GC-eligible after `revokeObjectURL`, so they accumulate for the page's lifetime.
- **Impact**: Steadily growing memory (one decoded audio blob per preview) during long sessions on the voices pages — degraded performance / eventual tab bloat, worst on characters with many emotion slots.
- **Fix sketch**: Track the current object URL in a ref; revoke it in `stop()`, in `a.onended`, before assigning the next `a.src`, and in the unmount cleanup effect.

## 4. Escape does not cancel an inline rename — the unmount fires `onBlur`, committing the typed value
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: edge-case / data-integrity
- **File**: `web/app/voices/_variants/CharacterTable.tsx:305`
- **Scenario**: A user double-clicks a character name, types a wrong/partial name, then presses **Escape** to abandon the edit. `onKeyDown` calls `setRenaming(null)`, which unmounts the focused input; React dispatches the pending `onBlur`, which runs `patchCharacter(c.character_id, { name: e.target.value.trim() || c.name })` — persisting the half-typed name the user meant to discard.
- **Root cause**: Commit logic lives entirely in `onBlur`, and Escape cancels by unmounting the focused field, which itself triggers `blur`. There is no flag distinguishing "cancel" from "commit". The same latent pattern exists in `TagEditor.tsx:63` (Escape sets `adding=false` while `onBlur={commit}` is bound).
- **Impact**: Escape silently saves instead of cancelling, corrupting the character's display name; the user has no signal their "cancel" actually wrote data.
- **Fix sketch**: Set a `cancelRef.current = true` in the Escape branch before `setRenaming(null)` and early-return from `onBlur` when it's set (reset after); apply the same guard to `TagEditor.commit`.

## 5. Unused `Button` import in CharacterTable
- **Severity**: low
- **Lens**: code-refactor
- **Category**: dead-code
- **File**: `web/app/voices/_variants/CharacterTable.tsx:9`
- **Scenario**: `import { Button, Eyebrow } from "@/components/ui/Primitives";` imports `Button`, but the component renders only native `<button>` elements — `Button` is never referenced.
- **Root cause**: Leftover import after the toolbar/actions were built with raw `<button>`s; only `Eyebrow` is actually used.
- **Impact**: Minor noise; a dead symbol that misleads readers about the component's dependencies and would trip a strict no-unused-imports lint rule.
- **Fix sketch**: Drop `Button` from the import — `import { Eyebrow } from "@/components/ui/Primitives";`.
