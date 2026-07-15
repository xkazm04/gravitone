# Dual-lens scan — web-design-system
> Files: 7 | Findings: 5 (crit 0 / high 1 / med 4 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. AppFrame auth gate fails open when Firebase env is absent
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: auth-gap / fail-open
- **File**: `web/components/ui/AppFrame.tsx:29`
- **Scenario**: A deploy (local dev, a preview build, or a prod deploy with a missing/typoed `NEXT_PUBLIC_FIREBASE_*` var) has `firebaseReady === false`. `useAuth` returns `ready: firebaseReady` (see `web/lib/useAuth.tsx:122`), so `ready` is `false` and `loading` is set to `false` immediately (`useAuth.tsx:63`).
- **Root cause**: `AppFrame` treats `ready` as "auth resolved", but it actually means "Firebase config is present". When `ready` is false, all three gates collapse: `resolving = ready && loading → false`, `blocked = ready && !loading && !user → false`, and the redirect effect `if (ready && !loading && !user)` (line 26) never fires. The `else` branch renders `children` (line 63), and the module nav renders because its guard is `!ready || user` (lines 40, 49) — `!ready` is true.
- **Impact**: The gated studio shell (Playground / Voices / API keys nav + protected page bodies) renders to every visitor, signed-in or not, with no redirect — silently, only under the misconfig. It reads as "auth works" until someone notices the studio is open. (Server APIs still enforce key auth, so this is a UI-gate fail-open, not a data breach — but the frame's whole contract is to bounce signed-out users.)
- **Fix sketch**: Gate on a true "auth resolved" signal, not config presence. Either default to blocked/redirect when `!ready` (fail-closed), or add an explicit `authResolved` flag to `useAuth` that is false until `onAuthStateChanged` first fires, and require it in `resolving`/`blocked`/redirect.

## 2. Lifetime audio priced against a MONTHLY ElevenLabs tier in SavingsTicker
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: money-truth / time-window-mismatch
- **File**: `web/components/ui/SavingsTicker.tsx:35`
- **Scenario**: The ticker reads `metrics.audio_seconds_total` — a cumulative, lifetime counter — and feeds `minutes = seconds/60` into `elCostForAudioMinutes(minutes)` (`web/lib/switchkit.ts:83`), which calls `estimateMonthly()` and returns the price of the cheapest *monthly* ElevenLabs tier that covers that character volume.
- **Root cause**: A lifetime total is passed to a per-month pricing model. As the deployment ages, the lifetime char count climbs through the monthly tiers, so the "kept vs ElevenLabs" figure jumps to ever-larger *subscription* prices (`$5 → $22 → $99 → $330 …`) that represent one month of ElevenLabs, not the accumulated cost of all audio ever served. The two operands cover different time spans.
- **Impact**: The displayed savings number is not a defensible comparison — it conflates lifetime usage with a single monthly subscription and drifts further from reality the longer the box runs. It is a user-visible money claim ("kept vs ElevenLabs").
- **Fix sketch**: Either price the lifetime volume at a per-character marginal rate (e.g. Business `$/char` × chars) instead of a monthly tier, or label the figure honestly as "≈ one month at your current volume". At minimum, don't feed a cumulative counter into `estimateMonthly`.

## 3. Motion tokens re-derived (and drifted) in StudioDark instead of imported from tokens.ts
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/components/variants/StudioDark.tsx:19`
- **Scenario**: `tokens.ts` exists specifically so modules "import these instead of re-deriving colors/motion" (`web/components/ui/tokens.ts:1`) and exports `EASE` (line 5) and a `rise` variant (lines 15-22). `StudioDark.tsx` re-declares its own local `ease` (line 19) and `rise` (lines 20-23), and hand-inlines the `Eyebrow` pill markup (lines 60-65) that `Primitives.Eyebrow` already provides.
- **Root cause**: The design-system single-source contract is bypassed. Worse, the copies have already drifted: `tokens.rise` uses `y:20 / duration:0.6 / delay i*0.07`, while `StudioDark.rise` uses `y:24 / duration:0.7 / delay i*0.08` — the exact divergence the token file was created to prevent (`.claude/skills/prototype/SKILL.md` even instructs "never hand-roll a button, panel, pill").
- **Impact**: Motion timing on the landing page silently disagrees with every other module; a future tweak to `tokens.rise` won't reach StudioDark. Maintenance debt plus visible inconsistency.
- **Fix sketch**: Delete the local `ease`/`rise` in StudioDark and `import { EASE, rise } from "@/components/ui/tokens"`; replace the inline eyebrow span (lines 60-65) with `<Eyebrow>{HERO.eyebrow}</Eyebrow>` from Primitives.

## 4. Two implementations of the same equalizer-bar animation (Waveform vs Equalizer)
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/components/ui/Primitives.tsx:47`
- **Scenario**: `Primitives.Waveform` (lines 47-77) and `Equalizer` (`web/components/ui/Equalizer.tsx:31-44`) both render `Array.from({length: bars})` of `.eq-bar` spans with the identical stagger math — `animationDelay: (i % 9) * 0.09s`, `animationDuration: 0.9 + (i % 5) * 0.12s`. `Wordmark` (Primitives:84) draws its logo bars via `Waveform`; `StudioDark` (line 39) draws the *same* logo via `Equalizer`.
- **Root cause**: Two components grew for the same visual: `Waveform` added a `color` gradient prop, `Equalizer` added `usePauseOffscreen` (an IntersectionObserver that pauses when scrolled away). Neither superset covers the other, so the animation formula is duplicated and the two logos behave differently — the `Waveform`-based Wordmark never pauses its infinite loop, while `Equalizer` does.
- **Impact**: A change to the bar timing/spacing must be made in two places; the logo animation is inconsistent between the app shell and the landing variant. Real, low-risk consolidation debt.
- **Fix sketch**: Keep one component — fold `Waveform`'s `color`/`bars` props into `Equalizer` (which already has the offscreen-pause) and have `Wordmark` render `Equalizer`, then delete `Waveform`.

## 5. PrototypeTabs.tsx is dead code — no importers
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: dead-code
- **File**: `web/components/ui/PrototypeTabs.tsx:13`
- **Scenario**: The in-app A/B prototyping harness (`export default function PrototypeTabs`) is imported by nothing. A repo-wide grep for `PrototypeTabs` / imports of `@/components/ui/PrototypeTabs` returns only the file itself and a mention in `.claude/skills/prototype/SKILL.md` — no `.tsx` route or component uses it.
- **Root cause**: The component's own doc comment says "When a winner is chosen, delete the losing variant and render it directly" — every module has apparently been resolved to a single `_variants/` winner, so the tab harness was left behind unwired.
- **Impact**: 59 lines of client component (plus a `localStorage` read/write path) ship in the bundle graph as maintainable-but-unused surface; readers assume it's live. Also, its `useEffect` deps `[storageKey, variants]` would re-run on every render if a caller ever passed an inline `variants` array — a latent footgun waiting for the first (nonexistent) consumer.
- **Fix sketch**: Delete `web/components/ui/PrototypeTabs.tsx` (and trim the SKILL.md reference), or, if the prototyping workflow is still intended, wire it into at least one route so it isn't silently dead.
