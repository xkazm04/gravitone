# Dual-lens scan — web-playground
> Files: 9 | Findings: 5 (crit 0 / high 1 / med 4 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. ensureShared re-uploads a take that is already publishing (duplicate publish + share-state desync)
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: race-condition
- **File**: `web/app/playground/_variants/PlaygroundConsole.tsx:248`
- **Scenario**: A user clicks "↗ share" on a take (share() sets `shares[t.id] = "pending"` and starts `uploadTake`), then — before it resolves — selects that take plus another and clicks "→ client review link", firing `createReview → ensureShared(t)`.
- **Root cause**: `share()` guards against an in-flight upload (`if (!t.url || existing === "pending") return;`, line 233), but `ensureShared()` does not: its early-return only fires when `existing` is a *settled* id (`existing !== "pending" && existing !== "error"`). A `"pending"` state falls straight through to a second `uploadTake(t)`. The two share entry points share the upload path but not the in-flight guard.
- **Impact**: The same take is POSTed to `/api/takes` twice, minting two public `/t/{id}` Voice Cards for one take. `setShares` is overwritten by whichever finishes last, so the visible "✓ link copied" id and the id embedded in the review link can differ — wasted storage and a silently inconsistent share record.
- **Fix sketch**: Give `ensureShared` an in-flight coalescing guard: keep a `Map<takeId, Promise<string>>` of pending uploads and have both `share()` and `ensureShared()` await the same promise, or treat `"pending"` in `ensureShared` by awaiting the existing upload instead of starting a new one.

## 2. Switching browser-fallback takes nulls the new take's playing state (cancel() fires the prior utterance's onend)
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: event-ordering
- **File**: `web/app/playground/_variants/useAudioPlayer.ts:60`
- **Scenario**: Backend is unreachable so takes play via SpeechSynthesis. Take A is speaking; the user clicks play on take B. `play(B)` calls `stop()`, which runs `window.speechSynthesis?.cancel()`.
- **Root cause**: `cancel()` asynchronously fires the *previous* utterance's `u.onend` (lines 84-90), which unconditionally runs `setPlayingId(null); setProgress(0)`. That callback lands *after* `play(B)` has already set `setPlayingId(B.id)`, because the onend fires in a later task while the rest of `play()` runs synchronously. The onend has no guard that it belongs to a still-current utterance.
- **Impact**: The new take B is audibly speaking but the UI shows it as stopped (play icon, no "current" row); the row's pause/stop no longer target it because `playingId` is null. Recovers only partially on the next 80ms timer tick.
- **Fix sketch**: Tag each utterance and ignore its `onend` if it is no longer `currentRef.current` (e.g. capture the take/utterance and early-return when `currentRef.current !== take`), or set the new utterance/currentRef before calling `cancel()`.

## 3. removeLine mis-clamps activeLine so emotion tags land on the wrong script line
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: state-desync
- **File**: `web/app/playground/_variants/PlaygroundConsole.tsx:200`
- **Scenario**: In Script mode with lines [0,1,2], the user is editing line 1 (`activeLine = 1`) and deletes line 0.
- **Root cause**: `setActiveLine((a) => Math.max(0, Math.min(a, script.length - 2)))` only *clamps to the new maximum index*; it never decrements `activeLine` when a line **above** it is removed. After deleting index 0, the old line 1 shifts to index 0, but `activeLine` stays 1 (clamp keeps it), so it now points at the old line 2. `moveLine` (lines 202-210) has the same flaw — it reorders lines without moving `activeLine` with the active row.
- **Impact**: `insertEmotion` (line 166) and the emotion palette then target the wrong line — the user tags a line they aren't editing. Silent, easy to hit while composing multi-character scripts.
- **Fix sketch**: In `removeLine`, when `idx < activeLine` decrement `activeLine` (then clamp); in `moveLine`, if `idx === activeLine` set `activeLine = j`, else if the move crosses the active index adjust by one.

## 4. Duplicated browser-fallback result literal (and near-duplicate generate* control flow)
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/app/playground/_variants/engine.ts:206`
- **Scenario**: `speak()` (lines 204-210) and `perform()` (lines 249-255) each build a byte-for-byte identical browser-fallback `SpeakResult`: same `plain`/`seconds` computation and the same `{ mode: "browser", peaks: waveHeights(plain.length * 31 + 7, 56), seconds, kb: 0, rtf: 0, synthSeconds: 0, queueSeconds: 0, ignoredSettings: [], segments: [] }`.
- **Root cause**: Two request builders that share the same fallback contract were written independently; the fallback shape was copy-pasted rather than factored out. The same copy-paste pattern appears in `PlaygroundConsole.tsx` `generateSolo` (331-360) and `generateScript` (303-329), which share the identical busy-guard / reset / build-Take / prepend / persist / `EngineBusyError`-vs-toast skeleton.
- **Impact**: Any change to fallback timing, the seed formula, or the error-handling skeleton must be edited in two places and will drift (e.g. the seed constant `31`/`7` silently diverging).
- **Fix sketch**: Extract `browserFallback(plainText): SpeakResult` in `engine.ts` and call it from both `speak()` and `perform()`; extract a `runGenerate(getResult, buildTakeMeta)` helper in `PlaygroundConsole.tsx` for the two generate paths.

## 5. Public /api/speak proxy forwards unbounded, unauthenticated client text to a 180s synthesis backend
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: trust-boundary
- **File**: `web/app/api/speak/route.ts:27`
- **Scenario**: An attacker (or a runaway client) POSTs a multi-megabyte `text` to the public `/api/speak` (or `/api/tts`) endpoint used by the free playground.
- **Root cause**: The route pipes `await req.text()` straight to `backendFetch('/v1/speak', …)` with no size cap, no rate limiting, and no auth; the composer textarea likewise sets no `maxLength`. `AbortSignal.timeout(180_000)` means one request can pin a synthesis worker for up to three minutes. `/api/tts/route.ts:17` has the same unbounded-text shape.
- **Impact**: Cheap, scriptable resource-exhaustion / GPU-cost abuse against the shared backend — a handful of long-text requests can saturate the render queue (the same queue whose 429 backpressure the UI already surfaces), degrading it for real users. Beyond the intended "free playground" allowance because per-request work is unbounded.
- **Fix sketch**: Reject bodies over a sane character/byte ceiling before forwarding (parse, check `text.length`, return 413), and add a lightweight per-IP rate limit on the public TTS proxies; mirror the cap client-side with a textarea `maxLength`.
