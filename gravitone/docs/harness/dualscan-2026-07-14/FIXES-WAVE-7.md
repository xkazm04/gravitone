# Dual-scan Fix Wave 7 — Web UX contract / functional correctness

> 6 commits, 7 findings closed (3 high, 4 medium).
> Gates: web `tsc` 0 / `next build` PASS. All web-side — fully verified.

## Commits

| # | Commit | Finding | Severity | File(s) |
|---|---|---|---|---|
| 1 | `e050960` | share-card OG image resolves to localhost | high | `app/layout.tsx` |
| 2 | `9a4337b` | 5xx bodies plain-text vs JSON | high | `lib/backend.ts` + 4 proxy routes |
| 3 | `98eebb6` | stale `?record=` deep-link replays | high | `voices/[characterId]/CharacterVoices.tsx` |
| 4 | `e7e7d48` | file-input not reset + Escape saves edit | medium ×2 | `voices/_variants/{CharacterTable,TagEditor}.tsx` |
| 5 | `d39f873` | removeLine/moveLine mis-targets activeLine | medium | `playground/_variants/PlaygroundConsole.tsx` |
| 6 | `4bbbcc0` | stale utterance onend nulls new take | medium | `playground/_variants/useAudioPlayer.ts` |

## What was fixed

1. **OG image resolves to localhost** — the `/t/[id]` + `/r/[id]` share cards used a root-relative `openGraph.images` path with no `metadataBase` set anywhere, so every social-share preview (the core "each share is a landing page" loop) rendered a broken image off-platform. Added `metadataBase` (from `NEXT_PUBLIC_SITE_URL`) to root metadata — fixes both share and review cards.
2. **Inconsistent error body shape** — the voice/character proxies returned plain-text error bodies on error statuses while success paths and the backend speak JSON, breaking a JSON-parsing (ElevenLabs-drop-in) client. Added a shared `jsonError(detail, status)` and applied it across the voices + characters JSON routes.
3. **Deep-link replay** — the `?record=` guided-recorder deep link was read in an effect keyed on `[character]`; every `addVoice→refresh()` replaced `character` and replayed the never-cleared param, yanking the user back to the URL emotion. Now one-shot (ref-gated) and the param is stripped via `history.replaceState`.
4. **File-input + Escape** — the quick-clone `fileRef` never reset `e.target.value`, so re-picking the same file after a failed clone did nothing (retry looked frozen); Escape in the rename input and the TagEditor add-tag input unmounted the field, firing the bound `onBlur→commit` and *saving* the half-typed value. Reset the input; guard commit with a `cancelRef` set on Escape.
5. **Script-line targeting** — `removeLine` only clamped `activeLine` to the new max, so deleting a line above the active one left `activeLine` pointing at a different row and emotion tags landed on the wrong line; `moveLine` didn't move `activeLine` at all. `removeLine` now decrements when a higher line is removed; `moveLine` follows the active row through the swap.
6. **Audio event ordering** — switching browser-fallback takes calls `speechSynthesis.cancel()`, which asynchronously fires the *previous* utterance's `onend` after `play(next)` already set the new take, nulling the new take's playing state. The `onend` now early-returns unless its take is still `currentRef.current`.

## Verification

| Gate | Result |
|---|---|
| web `tsc --noEmit` | 0 errors |
| web `next build` | PASS |

No web unit-test runner in this project; verified by `tsc` + `build` + code review. The interaction fixes (Escape-cancels-edit, deep-link one-shot, audio event ordering, script-line targeting) have no automated coverage and would each benefit from an eyeball / e2e pass — they're all user-input-timing bugs.

## Patterns established (catalogue items 21–24)

21. **A URL/deep-link intent is a one-time mount action, not a value derived from changing state.** Gate it with a ref and strip the param, or an effect keyed on that state replays it on every mutation. (CharacterVoices)
22. **Escape that unmounts a field fires its `onBlur`.** If commit lives in `onBlur`, Escape *saves* instead of cancels — guard with a `cancelRef` set in the Escape branch. (CharacterTable rename, TagEditor)
23. **Adjust index-based selection state when the underlying list mutates** — move it with its row on insert/remove/reorder, don't just clamp to the new length. (removeLine/moveLine)
24. **A stale async callback must verify it's still current before mutating shared state** — `speechSynthesis.cancel()` delivers the old utterance's `onend` after the next one starts; check identity first. (useAudioPlayer). Plus: **proxy error bodies must match the success content-type** so JSON clients don't break (jsonError).

## Deferred web-UX tail (not in this wave)

Lower-value / narrower web-UX findings left for a tail pass or an accessibility pass:
- **web-character-api #3/#4** (medium) — DELETE discards the upstream error body (hides 409 reasons); an upload timeout is reported as "backend unreachable" (logging-lie).
- **web-shell-landing #3** (medium) — `recRef.stop()` invoked inside a `setState` updater (double-stop under StrictMode).
- **web-shell-landing #5** (medium) — MobileNav has no focus trap → **accessibility pass** candidate (there's a broader a11y theme not yet scanned as its own wave).

## What remains (per INDEX)

Waves left: money-truth (fully web-verifiable), test integrity, dead-code/duplication. Plus the earlier-deferred service items (ingest lifecycle trio, keys.py event-loop cache, streaming errors swallowed, takes/voices atomic-write sweep) and this wave's web-UX tail.
