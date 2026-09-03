---
slug: meaningful-render-progress
type: perfect/direction
context: "[[TTS Playground]]"
lens: ux
status: shipped
size: S
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: f23915d
---
## What & why
On a CPU-only box a render can take seconds or minutes, and the console shows the same decorative equalizer either way — no elapsed time, no estimate, no queue position. The inputs already exist and are being discarded: the composer computes `estSec`, and the backend reports `X-Queue-Seconds`. Separately, `useHealthPoll` exists and is used only by the benchmarks view, so the page most affected by a loading or draining engine only discovers that state by failing a generate.

## Evidence
- `web/app/playground/_variants/PlaygroundConsole.tsx:710-720` — the rendering placeholder: pure decoration.
- `:187` — `estSec` computed; used for nothing user-facing during the render.
- `service/app.py` response headers include `X-Queue-Seconds`; forwarded by `web/app/api/speak/route.ts:19-20` and parsed at `engine.ts:174-175` (only shown AFTER completion, `:756-757`).
- `web/lib/useHealthPoll.ts:23` — single consumer `components/.../BenchmarksView.tsx:71`.
- `:488-490` — the busy-notice retry button fires `generate()` immediately though `retryAfterSec` is known.

## Acceptance criteria
- While rendering: elapsed time, an ETA derived from `estSec`, and queue position/wait when the backend reports one.
- The estimate is labelled as an estimate and degrades honestly when exceeded (no countdown that sits at "1s remaining", no fabricated progress bar for work whose progress is unknown).
- The playground consumes `useHealthPoll` so a loading/draining engine is visible BEFORE the user presses Generate — reuse the hook, do not re-roll polling.
- The retry affordance respects `retryAfterSec` (disabled/counting down) rather than firing instantly.
- Cancel remains reachable throughout (the shipped cancel path at `:639-645` must not regress).

## Risks / non-goals
- Honesty rule: an estimate presented as a measurement is worse than no estimate. Never render progress the app cannot actually observe.
- Non-goal: streaming playback or follow-along highlight (both rejected round 2).

## Build record
Builder W1. Rendering row now shows a ticking elapsed clock (the only MEASURED number) plus an ETA computed as `estAudioSec / rtf`, where rtf is the user's own last real render first and `health.metrics.realtime_factor` second — always labelled and sourced ("your last render ran at 1.4× realtime"). When exceeded it flips to "Past the ~Ns estimate — still rendering … an estimate, not a measurement of this run"; with no basis it says "No estimate yet — the first render on this machine is what calibrates one." No progress bar, no countdown. Queue depth (`queued`/`in_flight`) from useHealthPoll with a stale marker. `useHealthPoll(busy ? 5s : 30s)` reused (no second poller) drives a pre-Generate warning for loading/draining/unreachable, each phrased as the CONSEQUENCE of generating anyway, suppressed while a fallback banner already states the outcome. 429 retry counts `Retry-After` down and is disabled until zero. Cancel path untouched; the clock is keyed on `busy` so cancel clears it.

**Director review**: the honesty bar was the review's hard line and the diff clears it — every displayed number is either measured or explicitly labelled an estimate with its basis named. Gates on main: tsc clean, 34/34. MERGED.

Known follow-up handed to W2: `elapsedMs` lives in the top-level component so the take log re-renders every 250ms while busy; and the `busy`-driven interval change fires one extra /api/health per generate.
