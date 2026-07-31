---
slug: absent-is-not-empty
type: perfect/direction
context: "[[TTS Playground]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 2531a21
---
## What & why
Round 6 gated `/health`'s detail behind a scope. If the backend has a key and the studio does not, `/health` answers `{"status":"ready"}` with no `metrics` — and the console coerces the missing value to zero, so the queue chips do not render. "The queue reading is unavailable" then looks exactly like "the queue is empty", with the staleness flag false because the fetch succeeded. The ETA degrades to "No estimate yet", which is a different untrue statement. This is the repo's own no-false-empty-state rule, against a response shape the service only began returning last round.

## Evidence
- `web/app/playground/_variants/PlaygroundConsole.tsx:239-240` — `Number(health?.metrics?.queued ?? 0)`; `:143` and `:148` render the chips only when `> 0`.
- `web/lib/backend.ts:11-12` — the key is attached only if `GRAVITONE_API_KEY` is set, so the studio can legitimately be unauthenticated against a keyed backend.
- `web/lib/useHealthPoll.ts:60` — `stale` is false here, because the request succeeded.
- `PlaygroundConsole.tsx:477-479` — `liveRtf` degrades the same way, and `:135` prints "No estimate yet".
- `web/app/api/health/route.ts:7` — the one proxy route that does NOT use `proxyJson` and carries NO timeout, while `READ_TIMEOUT_MS` exists (`lib/backend.ts:26`) and the poller runs every 5s during a render (`PlaygroundConsole.tsx:237`).
- `PlaygroundConsole.tsx:476` + `shared.ts:48` — the ETA basis reads `rtf` from restored IndexedDB takes, which may carry round-5's understated summed value; the stored take has no version marker.

## Acceptance criteria
- Absent metrics are stated as absent and never rendered as zero; the user can tell "no queue" from "no reading".
- The ETA either names the basis it used or says it has none — it must not present an unavailable reading as an empty one.
- `/api/health` uses the same read timeout as every other proxy read.
- A stored take whose timing predates the wall-clock fix cannot silently calibrate today's estimate (version the record, or ignore pre-fix values).
- Tests cover the keyed-backend/unkeyed-studio shape specifically, since that is the configuration that produces it.

## Risks / non-goals
- Do not require a key in the studio as the fix — an unauthenticated studio against a keyed backend is a legitimate deployment; it just has to say what it cannot see.
- Non-goal: changing the service's `/health` contract, which round 6 set deliberately.

## Build record
Builder P2. `queued`/`in_flight`/`realtime_factor` are read as `number | null` via a `metric()` helper, never `Number(… ?? 0)`. Absent now renders an amber "queue depth unavailable to this studio — this is not a reading of an empty queue"; a real empty reading renders "queue clear", so **an empty queue is stated affirmatively rather than inferred from a missing chip** — three states where there was one. `metricsUnavailable` is scoped to "the engine answered", so an unreachable backend still reads as unreachable via the existing banner. The no-estimate line names its absence ("the engine's realtime factor is not visible to this studio…") instead of the misleading "the first render on this machine calibrates one". `/api/health` gained `AbortSignal.timeout(READ_TIMEOUT_MS)`; the builder deliberately kept it off `proxyJson` with the reason in-file (every consumer reads `status`, which `proxyJson`'s `{detail}` body does not carry).

`shared.ts` gained `TAKE_TIMING_VERSION` + `isTimingBasis()`, stamped on new takes in both generate paths. A restored take with no marker (a pre-wall-clock-fix `rtf`) still plays, shares and exports and still shows its own numbers, but **may not calibrate the estimate** — closing the silent-miscalibration path the scout found.

**Director review**: the builder ran an anti-vacuous check it was not required to run for this direction — reverting the three pieces produced 3 failures whose output literally displays the false empty state (`… your last render ran at 4× realtime.· queue clear`). Tests cover the keyed-backend/unkeyed-studio shape specifically, which is the configuration that produces the bug. Gates on main: tsc clean, 191 web tests / 18 files. MERGED.
