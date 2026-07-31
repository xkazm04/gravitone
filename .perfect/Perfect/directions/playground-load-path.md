---
slug: playground-load-path
type: perfect/direction
context: "[[TTS Playground]]"
lens: optimization
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 0077ade
---
## What & why
Three avoidable costs on the path the user feels most: the two independent roster GETs are awaited one after the other on every mount (Director-verified), the synthesized audio blob is thrown away and then refetched from its own object URL twice, and the whole WAV is decoded on the main thread before the take can appear. None of these change behaviour — they are pure latency and jank.

## Evidence
- `web/app/playground/_variants/PlaygroundConsole.tsx:124-129` — `apiJson("/api/characters")` awaited BEFORE `apiJson("/api/reviews/preferred")`; both `cache: "no-store"`; only an `alive` flag, so the requests themselves are not abortable (`:120`, `:142`).
- `web/app/voices/_data/characters.ts:87` — the voices module fetches the same `/api/characters` independently; round 3's `one-data-layer` shipped there and the playground never joined it.
- `engine.ts:170-171` — the blob from `res.blob()` is discarded after `URL.createObjectURL`; `PlaygroundConsole.tsx:350` (`persistTake`) and `engine.ts:50` (`uploadTake`) each `fetch()` the object URL to get it back.
- `engine.ts:23-40` — `computePeaks` decodes the full WAV (56 bars) on the main thread before the take is shown.

## Acceptance criteria
- The two roster requests run concurrently and are genuinely abortable on unmount (AbortController, not just a flag).
- One shared character-list data layer with the voices module — extend round 3's `one-data-layer` rather than forking a second cache; a stale-after-clone character list must not be the price (trace every consumer, per the round-2 lesson).
- The blob is carried through from synthesis to persist/upload — no refetching an object URL.
- Peak computation no longer blocks the take's appearance (defer or move off the main thread); the waveform still renders and the existing degrade-to-synthetic-bars path (`engine.ts:181-187`) survives.
- No behaviour change to what is displayed; `npx tsc --noEmit` + vitest green.

## Risks / non-goals
- Round-2 lesson applies verbatim: fetch-reduction work has previously created staleness regressions. Every consumer of the shared character list must be traced before merge.
- Non-goal: a service-worker/HTTP cache layer, or changing the proxy routes' caching headers.

## Build record
Builder W2. Roster + `/api/reviews/preferred` now start TOGETHER behind one AbortController (unmount genuinely cancels; the old `alive` flag only skipped the setState). New `loadRoster(signal)` in the voices data layer — the playground's duplicate `apiJson("/api/characters")` is gone, so the rail and the script `<select>` can no longer disagree about which Characters exist. `SpeakResult.blob` carries the audio through: `persistTake` and `uploadTake` no longer `fetch()` the take's own object URL, and `takeStore` stores the bytes once. `computePeaks` moved off the critical path — takes appear with synthetic bars and `refinePeaks()` swaps in the real waveform, returning null (keeping synthetic bars) on decode failure. Render clock hoisted into a `RenderStatus` child so the 250ms tick no longer re-renders every `layout` take card (the exact follow-up W1 handed over). Also cleared W1's leftovers on the same files: `uploadTake` goes through `apiJson`, `share()` shows the backend detail, and `useHealthPoll` is now self-scheduling so the busy/idle cadence switch stops firing an extra `/api/health` per generate.

**The round-2 staleness lesson was applied, not just acknowledged.** The builder traced every consumer before committing: `useCharacters()` → CharacterTable (incl. optimistic patch/delete + refresh); `useCharacter(id)` → detail page (untouched); PlaygroundConsole rail AND script select; `voices/new/page.tsx` (its own apiJson, refetched on commit and filtered to `cloned` — deliberately LEFT ALONE, no new coupling); CharacterTable.onPack and HeroMicDemo (raw fetches outside the module). Decision: **no time-based cache at all** — only in-flight request sharing, so every mount still sees server truth. Every mutation in the data layer calls the new `invalidateRoster()` so a post-mutation `refresh()` can never be served pre-mutation data.

**Director review**: read the `loadRoster` implementation closely since shared-request cancellation is the easy thing to get wrong — verified the last-waiter-out semantics (an aborting caller rejects immediately but only cancels the underlying request when nobody is left waiting, so one unmounting component cannot cancel another's in-flight load). Gates on main: tsc clean, 76/76 across 10 files, and `npx next build` compiles and prerenders. MERGED.
