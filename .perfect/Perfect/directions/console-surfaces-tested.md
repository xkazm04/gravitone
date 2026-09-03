---
slug: console-surfaces-tested
type: perfect/direction
context: "[[TTS Playground]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 205054a
---
## What & why
`PlaygroundConsole.tsx` is 1,378 lines with zero render tests, and the web app has no route-handler tests at all — which is precisely why a header can be added service-side and silently never arrive. Every surface round 4 built is unpinned, including the exact fallback-banner regression round 4 fixed. Three live bugs are sitting in that untested space today.

## Evidence
- No `PlaygroundConsole.test.tsx` anywhere; no route-handler tests in `web/` at all (scout-confirmed, 139 tests / 14 files).
- `PlaygroundConsole.tsx:649` — the share-error chip self-clears via a bare `setTimeout` with no mounted guard and no cleanup, calling `setShares` on a possibly-unmounted component; every other async path in the file checks `mounted.current`.
- `PlaygroundConsole.tsx:985` — `railRefs` is indexed by position in the FILTERED `railVisible` and never compacted (unlike `lineRefs`, `:531`), so `onRailKey` can focus a detached button after the filter changes.
- `PlaygroundConsole.tsx:126` — the render clock is `aria-live="off"` and the take log (`:1228`) has no live region, so a screen-reader user gets no announcement when a render finishes and a take appears.
- Untested round-4 surfaces: the fallback banner reflecting the LATEST take, `RenderStatus` basis selection, the rail filter + roving focus, `reuseTake` solo vs script, composer restore precedence, `removeLine`'s activeLine shift.
- `useAudioPlayer.ts` and `TakeCode.tsx` have zero tests.

## Acceptance criteria
- The three live bugs are fixed: the unguarded timeout, the stale rail refs, and the missing completion announcement.
- First render tests cover the round-4 surfaces most likely to regress — at minimum the fallback banner, `RenderStatus` basis selection, rail filter + keyboard navigation, and `reuseTake` for both modes.
- First route-handler tests cover the forward allowlist, the 413 body cap and `Retry-After` preservation.
- The tests pin BEHAVIOUR, not implementation — a refactor of the console should keep them passing.
- A test that would have caught the dropped `X-Synth-Segments` exists (coordinate with [[one-header-contract]] on where it lives).

## Risks / non-goals
- Fix the bugs AND pin them; a test documenting current broken behaviour is worse than none.
- The component needs `/api/characters`, `/api/reviews/preferred`, `/api/health`, an IndexedDB stub and an `AudioContext` stub — this is harness-building, so build the harness once and reuse it rather than stubbing per test.
- Non-goal: refactoring the console to make it testable; if a seam is genuinely needed, take the smallest one and say why.

## Build record
Builder P2 (+ Director integration fix `a854091`). Three fixes and the console's first render tests (21, one shared harness): a `role="status" aria-live="polite"` sr-only region naming the finished take, its seconds, its Character and the log count, cleared in `clearNotices()` so a spent message is not re-announced; the bare `setTimeout` in `share()`'s catch became an effect keyed on the errored-take set, so React cancels it on unmount and the updater only clears entries still in `"error"`; and `railRefs` became a `Map` keyed by `character_id`.

**The builder DISPROVED one of the direction's claims and said so.** The scout reported the stale rail-refs as a live bug. Reverting the fix produced **0 failing tests**, and the builder explained why: the inline ref callback is a fresh closure every render, so React detaches and re-attaches every visible index on each commit, and stale entries only ever sit at indices `>= railVisible.length`, which `onRailKey` never targets. It kept the keyed Map as **hardening** — removing the unbounded array and making the invariant structural, one memoised callback away from mattering — and said exactly that in the code comment, the test comment and the commit message **rather than claiming a fix**. Director accepts: that is the standard.

Anti-vacuous, each fix reverted in isolation: live region removed → 3 fail; effect → bare `setTimeout` → 1 fail (`expected 1 to be +0`, a timer surviving unmount); keyed map → position array → **0 fail, reported as 0**.

**Director-fixed CROSS-BUILDER BREAK (`a854091`)**: P1 made `synthSegments` and `format` required on `SpeakResult` in the same wave this harness was written; both branches were green alone. On main **all 191 tests passed while `tsc` FAILED** — a mocked fixture is only type-checked, never executed, so vitest could not see it. The builder had predicted the break and left `satisfies SpeakResult` pointing at the one fixture to update, which is exactly where tsc sent me. This is why the integration gate runs both suites and why "tests pass" is never sufficient.

Gates on main: tsc clean, **191 web tests / 18 files** (139 at round start). MERGED.
