---
slug: one-header-contract
type: perfect/direction
context: "[[TTS Playground]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 21a7064
---
## What & why
`X-Synth-Segments` is emitted by both premium routes and silently dropped at the proxy — it never reaches the browser at all. The cause is structural rather than a missed line: three separate hand-maintained forward allowlists, each a shorter subset of the service's own `CORS_EXPOSE_HEADERS` (the authoritative "headers a client is meant to read"), with no shared constant and nothing that fails when the service adds one. This is the mechanism by which any future header will also go missing.

## Evidence
- `service/app.py:1326` and `:1435` — `X-Synth-Segments` emitted when a request became more than one job.
- `web/app/api/speak/route.ts:16-23` — `FORWARD_HEADERS` omits it (Director-verified); `web/app/api/performance/route.ts:13-20` likewise; `grep -r "X-Synth-Segments" web/` → no hits.
- `web/app/api/tts/route.ts:47-54` — a third, different subset, which also drops `X-Cache` (the only route that emits it) and `X-Sample-Rate`.
- `service/app.py:125-132` — `CORS_EXPOSE_HEADERS`, the service's own list of what a client should be able to read.
- `web/app/api/tts/route.ts:51-52` — sets a header to `""` when upstream omitted it, rather than omitting it (the allowlist loop in `lib/backend.ts:113-116` gets this right).

## Acceptance criteria
- One shared source of truth for forwarded headers replaces the three hand-kept lists.
- A header the service exposes cannot silently fail to arrive at the browser.
- A drift guard fails the suite when the service's exposed set and the studio's forwarded set diverge — the pattern round 6's `ExposeHeaderDriftTests` used successfully on the service side, applied from the web side.
- A header the upstream did not send is omitted, never forwarded as an empty string.
- `X-Synth-Segments` actually reaches the console and is used or deliberately not used, stated either way.

## Risks / non-goals
- The three routes do not need identical lists — `/api/tts` serves a different route with different headers. The requirement is one derivation, not one literal.
- Non-goal: changing what the service exposes.

## Build record
Builder P1. New `web/lib/serviceHeaders.ts`: `SERVICE_EXPOSED_HEADERS` (a mirror of `service/app.py::CORS_EXPOSE_HEADERS`) + `forwardExposedHeaders()`. The three route literals are gone; `proxyWavPost` and `/api/tts` both derive from it. Empty-string forwarding is gone (`/api/tts` used to send `""` for headers the backend omitted). First route-handler tests in `web/` shipped alongside (`app/api/speak/route.test.ts`, `app/api/tts/route.test.ts`).

`X-Synth-Segments` is now decoded onto `SpeakResult.synthSegments` and **deliberately NOT rendered** — the take card already draws one chip per segment, so the count is on screen as the ribbon's length. Recognising that a newly-available datum does not need a new UI element is the right instinct and worth recording.

**Director review + independent teeth check**: the drift guard parses `app.py`'s `CORS_EXPOSE_HEADERS` literal and fails on divergence **in either direction**. I verified it myself rather than trusting the report — deleted `X-Synth-Segments` from the mirror and got **3 failing tests**; restoring it returned all 5 to green, tree clean afterwards. This closes the MECHANISM that ate the header, not just the instance. Gates on main: tsc clean, 170 web tests / 17 files at merge. MERGED.
