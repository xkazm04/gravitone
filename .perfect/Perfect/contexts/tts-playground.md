---
name: TTS Playground
type: perfect/context
group: Web Studio
category: ui
opportunity: 8
last_proposed: 2026-07-28 (round 7)
cooldown_until: round 9
directions: ["[[performance-composer]]", "[[honest-status-timing]]", "[[durable-takes]]", "[[streamed-playback]]", "[[follow-along-highlight]]", "[[failure-truth-console]]", "[[meaningful-render-progress]]", "[[playground-load-path]]", "[[durable-iteration-loop]]", "[[reachable-characters]]", "[[premium-format-in-console]]", "[[one-header-contract]]", "[[absent-is-not-empty]]", "[[console-surfaces-tested]]", "[[proxy-streams-audio]]"]
---
## Current state (scouted 2026-07-13, round 2)
Single Console variant. Character rail (cap 10, client-review preferred default with badge), metatag emotion chips + radial wheel, /api/speak → /v1/speak with X-Segments ribbon (fallback strikethrough), expression sliders, takes log with real waveform peaks, WAV download, code export, share /t/{id}, client review /r/{id}, browser-voice fallback.
Rough: streaming endpoint unused (engine.ts:68 full blob; proxy buffers); no /v1/performance UI or proxy; proxies drop X-Synth/Queue-Seconds + X-Ignored-Settings; errors collapse into fallback (429 indistinguishable); /api/tts orphan route; takes ephemeral (refresh loses session); object URLs leak; AudioContext per take; dup share/ensureShared upload paths; estSec magic constant duplicated; stripTags regex misses digits/hyphens; hardcoded output_format=wav_24000.
## Current state (BANKED scout, 2026-07-28, round 4 prefetch)
Mount verified: page.tsx:5-13 → AppFrame (auth-gated, though copy at PlaygroundConsole.tsx:470 says "free playground") → PlaygroundConsole. No orphan components in `_variants/`. Flow: roster+preferred fetch → character rail (hard `.slice(0,10)`, :517) → solo/script mode → emotion chips/radial wheel (`wrapWithTag`, lib/emotions.ts:51-58) → generate via `newRun()` AbortController (:373-377) → engine.speak → /api/speak → POST /v1/speak (app.py:660) → full blob → `computePeaks` (56 bars, main thread) → take → IndexedDB (takeStore.ts, cap 50).

Shipped-and-live: cancel-generation (complete, tested engine.test.ts:57-93), performance-composer (script mode + /api/performance + per-line report ribbon), durable-takes, honest-status-timing (X-Synth/Queue-Seconds → :756-757, X-Ignored-Settings chip :842), nearest-emotion-fallback (server side only).

Rough (evidence):
- **Stale fallback banner** — `takes.find(t => t.mode === "browser")` (:198) scans the WHOLE list, so one old browser take pins the amber "backend unreachable" banner (:480-484) forever, even after successful gravitone takes.
- **Copy lies about emotions** — UI promises "falls back to baseline" (:8, :476, :619, EmotionPicker.tsx:98); server does nearest-neighbour first (emotions.py:141-143). Ribbon shows truth only after generating.
- **engine.ts outside the apiFetch contract** — speak/perform never call throwDetail/readDetail; backend `detail` (incl. the request-correlation id) is discarded → generic "Generation failed" (:421, :454). 404 unknown-character collapses into the browser-voice fallback (engine.ts:241) instead of saying the character is gone.
- **No dedupe/cache of identical synthesis** — generateSolo (:425-457) has no (text, characterId, expr) guard; takes[] already stores exactly that (shared.ts:42-43). Re-Generate pays full CPU synthesis again.
- **Serialized roster fetches** — /api/characters awaited before /api/reviews/preferred (:124-129); un-abortable (`alive` flag only); no module-level cache, and app/voices/_data/characters.ts:87 fetches the same list independently.
- **Blob refetched twice** — gravitoneResult discards the blob (engine.ts:170-171); persistTake (:350) and uploadTake (engine.ts:50) each `fetch(objectURL)` to get it back.
- **Rendering placeholder conveys nothing** — decorative equalizer (:710-720), no elapsed timer/ETA/queue position, though estSec (:187) and X-Queue-Seconds exist. Multi-minute CPU renders look identical to 2-second ones.
- Composer state (text/script/expr/mode/charId) is plain useState — refresh restores takes but wipes the script (:76-86). Characters 11+ unreachable in solo mode (:517) but selectable in script mode (:570). No maxLength vs 8000-char server cap (app.py:656) / 128 KB proxy cap. Retry button ignores known retryAfterSec (:488-490). Review-URL copy claims "✓ copied" after a denied clipboard (:341, :696).
- Half-adopted shared hooks: useHealthPoll used ONLY by BenchmarksView.tsx:71 (playground never polls health); useMounted hand-rolled in EmotionPicker.tsx:37-38; useCopyFeedback only inside TakeCode. Bespoke banners at :486-497 and :499-504 sit next to ErrorBanner (no role="alert").
- /api/tts is NOT on the playground path (consumers: HeroMicDemo, voices/_data/characters.ts, MigrationKit) and is the only synthesis route still hand-rolled instead of proxyWavPost (route.ts:27-58, defaults unknown voice to "alba").
- Tests: vitest runner exists; playground coverage is engine.ts ONLY. Untested: PlaygroundConsole (857 lines, zero render tests), useAudioPlayer (speechSynthesis onend race :103), takeStore, EmotionPicker, computePeaks, wrapWithTag caret math, and all of lib/backend.ts (413 cap + Retry-After passthrough).

## Round-7 re-scout (2026-07-28) — the console vs the routes it calls
Re-scouted because rounds 5-6 rewrote `/v1/speak` and `/v1/performance` underneath it. **All five round-4 directions verified LIVE and complete** (failure-truth-console, meaningful-render-progress, playground-load-path, durable-iteration-loop, reachable-characters) — the scout traced each to its mount point.

Two pleasant surprises: `X-Synth-Seconds` needed NO web change — the console had been printing the concurrent-sum number since round 2 and now prints a true one; and `X-Queue-Seconds` was already wired to a chip that had been dead markup for rounds because `/v1/speak` never sent it, and starts appearing today.

Rough:
- **`output_format` ignored and contradicted** — `proxyWavPost` has no query-forwarding parameter and hardcodes `Content-Type: audio/wav` (Director-verified); the UI asserts "exports 24kHz wav" and the code export teaches neither parameter. → [[premium-format-in-console]]
- **`X-Synth-Segments` dropped at the proxy** — three hand-kept allowlists, each a subset of the service's `CORS_EXPOSE_HEADERS`, nothing fails on drift (Director-verified). → [[one-header-contract]]
- **Missing `health.metrics` renders as an empty queue** — a keyed backend with an unkeyed studio produces exactly this shape, and `stale` is false because the fetch succeeded. Plus `/api/health` is the one proxy route with no timeout, polled every 5s during a render. → [[absent-is-not-empty]]
- **Zero render tests on 1,378 lines, zero route-handler tests in all of `web/`** — with three live bugs sitting in the gap (unguarded `setTimeout`, stale rail refs, no completion announcement). → [[console-surfaces-tested]]
- **`proxyWavPost` buffers the whole clip** (`lib/backend.ts:117`) while its sibling in the same file streams. → [[proxy-streams-audio]]
- Not taken: the ETA basis reads `rtf` off restored takes with no version marker (folded into `absent-is-not-empty`); `voice_settings` is sent once per performance LINE, identically; the composer debounce rewrites the whole script on a pure focus move (`activeLine`); `browserFallback` fabricates `seconds` and renders it in the same slot as measured audio; a11y gaps (`aria-expanded` on a button that unmounts, chips conveying availability only via `title`, `role="dialog"` on the backdrop while focus is trapped in the inner panel); `fetchRoster` is a one-line wrapper with one caller; `MAX_BODY_BYTES` mirrors a `lib/backend.ts` constant with nothing enforcing it.

## Direction history
2026-07-13 — proposed 5: performance-composer ✅ honest-status-timing ✅ durable-takes ✅ streamed-playback ❌ follow-along-highlight ❌.
2026-07-28 (round 7) — proposed 5, **all 5 accepted**: premium-format-in-console ✅ one-header-contract ✅ absent-is-not-empty ✅ console-surfaces-tested ✅ proxy-streams-audio ✅.
2026-07-28 (round 4) — proposed 5, **all 5 accepted**: failure-truth-console ✅ meaningful-render-progress ✅ playground-load-path ✅ durable-iteration-loop ✅ reachable-characters ✅. Slate drawn from the banked scout; Director independently verified the rail cap (:517), the stale-banner `find` (:198) and the serialized roster await (:124-129) before presenting.
## Shipped
Round 7 (2026-07-28) — 5/5:
- [[one-header-contract]] → **21a7064** — one derived source of truth for forwarded headers + a drift guard the Director teeth-checked personally.
- [[premium-format-in-console]] → **2400f6b** — mp3 export end to end (download + code export); share/review stay wav-only and SAY SO, because `takes.py` rejects non-RIFF.
- [[proxy-streams-audio]] → **b69cc11** — measured 102 MB → 26 MB peak RSS on a 64-line performance.
- [[absent-is-not-empty]] → **2531a21** — three queue states where there was one; takes carry a `timingVersion` so a pre-fix take cannot calibrate the ETA.
- [[console-surfaces-tested]] → **205054a** (+ Director **a854091**) — completion announcement, timer leak fixed, and the console's first 21 render tests.
