# Dual-lens scan — web-shell-landing
> Files: 6 | Findings: 5 (crit 0 / high 2 / med 3 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Demo hero silently plays a premade voice while claiming "your voice, cloned"
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: silent-failure / success-theater
- **File**: `web/components/variants/HeroMicDemo.tsx:67`
- **Scenario**: The clone POST returns 200 but the body lacks `voice_id` (empty/204 body, schema drift, or partial success). `voice = await cr.json().catch(() => ({}))` yields `{}`, `voice.voice_id` is `undefined`, and there is no guard before the synthesis call.
- **Root cause**: `voiceId: voice.voice_id` is passed to `/api/tts` unchecked. In `web/app/api/tts/route.ts:18` a missing voiceId falls back to the built-in `"alba"` voice (`VOICE_MAP[""] ?? undefined ?? "alba"`). So synthesis succeeds against a stock voice, the UI reaches `phase === "ready"` and renders “● your voice, cloned” + the SAMPLE_TEXT quote.
- **Impact**: The single most important demo on the landing page — the whole "hear YOUR voice" pitch and its consent framing — can play a stranger's stock voice presented as the visitor's own clone. Undetectable success theater; erodes the product's core credibility.
- **Fix sketch**: After the clone call, `if (!voice.voice_id) throw new Error("clone returned no voice")`. Independently, make `/api/tts` reject an empty/unknown voiceId with 400 instead of silently defaulting to `alba`.

## 2. Throwaway demo character deleted by a reconstructed slug, not the returned character_id
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: identity-mismatch / consent-data-retention
- **File**: `web/components/variants/HeroMicDemo.tsx:48`
- **Scenario**: Cleanup builds `cid = demoName.toLowerCase().replace(/[^a-z0-9]+/g, "-")` and DELETEs `/api/characters/${cid}` (line 80), instead of using the `character_id` the clone response already returns (the app uses `voice.character_id` everywhere else, e.g. `web/lib/voiceVault.ts:32`, `CharacterTable.tsx`).
- **Root cause**: The client re-implements the backend slug (`service/voices.py:258` `_slug`), but the two rules differ — the backend `.strip()`s whitespace and `.strip("-")`s leading/trailing hyphens; the client does neither. Correct deletion today rests on the coincidence that the current `Demo visitor <hex>` name happens to slug identically. Any name-format change (trailing punctuation, non-ASCII, empty `Math.random()` suffix) makes `cid` diverge, and the DELETE is fire-and-forget with `.catch(() => {})` so the divergence is invisible.
- **Impact**: When it diverges, the cloned (biometric) demo voice is retained on the server forever, silently breaking the on-screen promise “demo voice is deleted right after playback,” and orphans accumulate with zero signal.
- **Fix sketch**: DELETE `voice.character_id` from the clone response; drop the inline re-slug. Optionally log/surface a failed cleanup instead of swallowing it.

## 3. `recRef.stop()` invoked as a side effect inside a `setState` updater
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: race-condition / side-effect-in-render-path
- **File**: `web/components/variants/HeroMicDemo.tsx:102`
- **Scenario**: The 1s interval calls `setSeconds((s) => { if (s + 1 >= MAX_SECONDS) recRef.current?.stop(); return s + 1; })`. With `reactStrictMode: true` (`web/next.config.mjs:3`) React double-invokes state updaters in dev, so at s=19 `stop()` fires twice; the second call hits an already-inactive `MediaRecorder` and throws `InvalidStateError`. State updaters are also expected to be pure.
- **Root cause**: A DOM side effect (stopping the recorder) is embedded in a supposedly-pure reducer function rather than derived from state in an effect.
- **Impact**: Dev-time exceptions and non-deterministic behavior around the auto-stop boundary; fragile under React concurrency. In prod a rapid Stop-click near the 20s tick can also double-call `stop()`.
- **Fix sketch**: Return the new count from the updater only; move the auto-stop into a `useEffect` watching `seconds` (or guard with `if (recRef.current?.state === "recording")`).

## 4. No cancel affordance while cloning/rendering — a stalled backend traps the user
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: recovery-gap
- **File**: `web/components/variants/HeroMicDemo.tsx:174`
- **Scenario**: After "Stop & clone", the `cloning`/`rendering` UI (lines 174–182) renders only an equalizer and status text — no cancel/back button. The client `fetch`es (lines 59, 64) have no `AbortController`; recovery depends entirely on the proxy timeouts (`/api/voices` 300s, `/api/tts` 120s).
- **Root cause**: The busy states are decorative-only and there is no client-side abort, so a slow/hung backend leaves the visitor watching a spinner for up to ~5 minutes before it flips to the error phase.
- **Impact**: On the highest-intent landing interaction, a cold-start or overloaded CPU backend produces a multi-minute dead-end whose only escape is a full page reload; likely bounce.
- **Fix sketch**: Add a Cancel button in the cloning/rendering states wired to an `AbortController` that aborts both fetches and returns to `idle`; consider a shorter client-side timeout with a friendly retry.

## 5. MobileNav manages open/Escape focus but has no focus trap
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: accessibility / focus-management
- **File**: `web/components/ui/MobileNav.tsx:41`
- **Scenario**: On open, focus moves to the first link (lines 41–43) and Escape restores focus to the trigger (lines 26–31), but nothing constrains Tab. A keyboard user tabbing past the last link moves focus to page content behind the still-open glass overlay.
- **Root cause**: The dropdown implements partial focus management (the docstring implies a complete keyboard flow) without wrapping Tab/Shift+Tab within the panel.
- **Impact**: Keyboard/screen-reader users lose their place: focus lands on visually-obscured background elements while the menu is open, and there is no way to cycle within the menu — a real navigation break on the mobile shell shared by the landing and app chrome.
- **Fix sketch**: Trap Tab within the panel (cycle from last→first link and Shift+Tab first→trigger), or close the menu when focus leaves it via a `focusout` handler.
