---
slug: retry-not-failure
type: perfect/direction
context: "[[Voice Creation Studio]]"
lens: ux
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 8f1918e
---
## What & why
Round 5 added an ingest concurrency cap that answers 429 with `Retry-After` on /scan, /speaker and /commit. The studio renders it as a rose "the action failed" banner, when the truth is "try again in a moment" — and the repo's own honest-failure law reserves rose for failure and amber for recoverable/degraded. The plumbing is already there and already used correctly elsewhere in the app. Separately, the three mutating buttons have NO in-flight state at all, so the scan kickoff (120s proxy timeout) gives the user no feedback whatsoever; and client-side upload validation has drifted from the backend it deliberately mirrors, so a 20-minute file uploads 50 MB to earn a 400 that the client could have predicted.

## Evidence
- `service/ingest_api.py:288-297` — the admission gate, called at `:504` (/scan), `:567` (/speaker), `:607` (/commit).
- `web/lib/backend.ts:72-73` — `proxyJson` already preserves `Retry-After` and passes the upstream status through verbatim.
- `web/app/voices/new/page.tsx:109`, `:128-131`, `:167` — all three call sites surface the detail through a rose `ErrorBanner`; nothing branches on 429.
- The playground already does this correctly: `web/app/playground/_variants/engine.ts:218-219` + `PlaygroundConsole.tsx:763` (countdown, disabled retry until `Retry-After` elapses).
- `web/app/voices/new/page.tsx:41` — `submitting` is a REF, so no button ever shows a pending state; `web/app/api/ingest/scan/route.ts:7` allows 120s.
- `web/app/voices/new/page.tsx:562-574` — client checks size, extension/mime and the 3s FLOOR only; no ceiling, and a null `probeDuration` is waved through, while `service/ingest_api.py:168-170` now fails CLOSED on unknown duration and enforces `INGEST_MAX_CLIP_SECONDS`.

## Acceptance criteria
- A 429 is presented as recoverable (amber, per CLAUDE.md § Honest failure surfaces) with a retry affordance driven by the real `Retry-After` — reuse the playground's pattern, do not re-roll it.
- Every mutating action has a visible in-flight state; double-submit stays impossible.
- The client mirrors the backend's duration CEILING and its fail-closed stance on unknown duration, so an over-long or unreadable file is rejected before the upload rather than after.
- The mirrored limits are sourced in ONE place — the current duplication (`page.tsx:523-530` re-declaring the backend's caps and extension whitelist by hand) is what allowed the ceiling to be missed.

## Risks / non-goals
- Do not weaken the backend gate: the client check is an optimization for the user, never the enforcement point.
- Non-goal: redesigning the dropzone or the upload screen.
- Non-goal: client-side transcoding or trimming of over-long files.

## Build record
Builder W2 (+ Director service fix `a58b37f`). 429 is now amber with a `retryIn` countdown mirroring the playground's `EngineBusyError` pattern — same banner, same "retrying inside the window only adds another rejection" disable rule — branched into `startScan`, `chooseSpeaker` and `commit`, with the retry re-invoking THIS render's handler via a stored action discriminant rather than a stale closure. A new `pending` state renders in-flight labels on all three buttons while the `submitting` ref keeps the atomic gate; `setPending` after `await` is `useMounted`-guarded. Upload validation gained the duration CEILING and a fail-closed stance on unreadable length.

**The builder found an error in the DIRECTION'S OWN EVIDENCE.** The direction claimed the countdown could be driven by a real `Retry-After` because `proxyJson` preserves it — true, but `_admit()` raised a bare `HTTPException(429)`, so there was never a header to preserve. Rather than fabricate a backend wait, it read the real header when present and otherwise said "Retry unlocks in Ns" from its own backoff, and flagged the one-line service fix it was scoped out of making. **Director made it (`a58b37f`)**: `_admit` now sends `Retry-After: 5`, coarse on purpose because a scan holds its slot for minutes and any precise number would be a guess dressed as an ETA. The two 429s in the product no longer disagree about whether a caller is told when to come back.

**A reasoned deviation from an acceptance criterion, accepted**: "fail closed on unknown duration" is right for the backend (its `None` means ffprobe failed) but wrong verbatim for the browser (its `null` usually means only that it cannot decode `.amr/.wma/.mkv`, which ffprobe reads fine). The builder fails closed only when `canPlayType` says the browser COULD decode and still got no length — otherwise the server decides. Taking the criterion literally would have made the client an enforcement point rejecting files the backend accepts. Correct call.

Open follow-up the builder recommends: serve `max_upload_bytes`/`min_clip_seconds`/`max_clip_seconds`/`_AUDIO_EXTS` from `/v1/ingest/modes` and delete the web-side constants — the hand-mirror is what let the ceiling go unmirrored in the first place. Gates: tsc clean, 139 web tests, 469 service. MERGED.
