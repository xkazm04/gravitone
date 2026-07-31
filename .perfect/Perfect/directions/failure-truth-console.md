---
slug: failure-truth-console
type: perfect/direction
context: "[[TTS Playground]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 3c47071
---
## What & why
The playground is the app's main surface and it is the least honest one about failure. The service produces a sanitized 500 carrying a request-correlation id (the whole point of `errors.sanitized_500`), and the console throws it away — every failure collapses into one generic sentence. A stale character id produces a browser-voice take rather than saying the character is gone. The "backend unreachable" banner never clears. And the pre-generation copy promises baseline-fallback while the server does nearest-neighbour. Each is a small edit; together they are the difference between a console you can debug and one that shrugs.

## Evidence
- `web/app/playground/_variants/engine.ts` — `speak`/`perform` use raw `fetch`, never `throwDetail`/`readDetail` (`web/lib/apiFetch.ts:27,36`); errors surface as the generic strings at `PlaygroundConsole.tsx:421,454`.
- `engine.ts:241` — 404 unknown-character falls into the browser-voice fallback path (service raises it at `app.py:676`, `:765`).
- `PlaygroundConsole.tsx:198` — `takes.find(t => t.mode === "browser")` scans the WHOLE take list (Director-verified), so the amber banner at `:480-484` stays pinned after later successful renders.
- Copy vs behaviour: `PlaygroundConsole.tsx:8`, `:476`, `:619`, `EmotionPicker.tsx:98` say "fall back to baseline"; `service/emotions.py:141-143` substitutes a neighbour first.
- Bespoke banners `:486-497` and `:499-504` (no `role="alert"`) sit next to `components/ui/ErrorBanner.tsx:23`, which is already used at `:478`, `:701`.
- `:341` + `:696` — review-link copy claims "✓ review link copied" after a `.catch(() => {})` on a denied clipboard.
- `:352` — `persistTake` swallows all errors, so a quota failure silently breaks the durable-takes promise.
- `:332-337` — `createReview` is the last raw `fetch` + manual `r.json()` despite `apiJson` being imported at `:11`.

## Acceptance criteria
- `engine.ts` goes through the `apiFetch` contract: the backend `detail` (including the request id) reaches the user's error message; transport vs 500 vs 503 vs 429 triage in `FALLBACK_COPY` still works.
- A 404 unknown-character reports that the character is gone instead of silently producing a browser-voice take.
- The fallback banner reflects the LATEST take and clears once a gravitone take succeeds.
- The two bespoke banners become `ErrorBanner` (correct severity, `role="alert"`); no hand-rolled banner markup remains in the file.
- Emotion copy in the console and the picker states what the server actually does (nearest emotion, then baseline).
- Clipboard success is only claimed when the write succeeded (use `useCopyFeedback`, already in the repo); a failed take-persist is surfaced.
- `createReview` uses `apiJson`.

## Risks / non-goals
- Do not change the fallback *mechanism* (browser voice on transport failure) — only what the user is told about it.
- Non-goal: streamed playback (rejected round 2), any new banner component.

## Build record
Builder W1. Introduced one `triageFailure()` in engine.ts on top of `lib/apiFetch` (`readDetail`/`throwDetail`): 429 → EngineBusyError (unchanged), 404 → throws the backend detail (no more browser-voice take for a deleted Character), everything else keeps the fallback but carries the sanitized `detail` (request id) via new `SpeakResult.fallbackDetail` → `Take.fallbackDetail` → banner. Bonus: proxy 503 "backend unreachable" now read apart from a draining engine. Banner switched from `takes.find(browser)` (never cleared, survived session restore) to last-run `fallback` state. Both bespoke banners → ErrorBanner (rose = nothing produced, amber = degraded). Clipboard via useCopyFeedback; `copyFailed` state deleted; review banner prints one of three TRUE strings + explicit copy button. createReview → apiJson. Failed persistTake AND failed session restore now surface as `storageErr`. Emotion copy corrected to "nearest recorded emotion, then baseline" in console prose, chip titles, wheel titles, module headers.

**Director review**: read the full diff. Verified `throwDetail` returns `Promise<never>` so no double body read in triageFailure; verified takes are prepended so last-run semantics hold; verified the "unreachable" engineNotice branch is REACHABLE (web/app/api/health/route.ts:12-17 returns `{status:"unreachable"}` on 503, and useHealthPoll parses without an ok-check). Deliberate scope call accepted: the per-take ignored-settings chip stays a chip, not a banner (role="alert" on every historical take card would be noise). Gates on main after merge: `npx tsc --noEmit` clean, `npx vitest run` 4 files / 34 passed (was 29; +5 engine tests). MERGED.
