---
slug: proxy-streams-audio
type: perfect/direction
context: "[[TTS Playground]]"
lens: optimization
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: b69cc11
---
## What & why
The synthesis proxy holds every rendered clip whole in memory before the browser sees a byte. `proxyWavPost` awaits `arrayBuffer()` and re-emits, so a 64-line performance — the largest thing the product can produce — is buffered in the Node process on the same box that just synthesized it. The sibling helper in the same file already streams; this path never did.

## Evidence
- `web/lib/backend.ts:117` — `return new Response(await upstream.arrayBuffer(), …)`. (Director-verified.)
- `web/lib/backend.ts:132` — `streamIngestAsset` streams the body through, in the same module.
- `web/app/api/speak/route.ts:26` and `web/app/api/performance/route.ts:23` — both synthesis routes go through `proxyWavPost`.
- `service/app.py` `/v1/performance` accepts 64 lines, each expanding into multiple metatag segments, concatenated into one response.

## Acceptance criteria
- The response body streams through the proxy instead of being fully buffered.
- The header allowlist, the non-OK JSON error path and `Retry-After` preservation are unchanged.
- The take, its blob, its peaks, playback and download all behave identically — this is invisible to the user except in memory and time-to-first-byte.
- Memory during a large performance is measurably lower; report the before/after.

## Risks / non-goals
- **This is NOT streamed playback** (rejected twice: round 2, and again as a re-pitch guard). The player is untouched and the take still arrives complete before it is added to the log. This is the proxy holding a whole render in memory.
- The blob-carry-through that round 4 shipped must survive: `engine.ts` keeps the blob rather than refetching the object URL.
- Non-goal: changing the service's response, or the 128 KB request-body cap.

## Build record
Builder P1. `new Response(upstream.body, …)` replaces `await upstream.arrayBuffer()`. Header forwarding, the non-OK JSON path and `Retry-After` are untouched, and the 180s `AbortSignal.timeout` now bounds the streamed read exactly as it previously bounded `arrayBuffer()` — same semantics.

**Measured, not asserted**: the two response shapes in isolation on a ~25 MB body (about a 64-line performance), peak RSS delta — buffered **102.3 / 101.8 MB**, streamed **25.9 / 25.9 MB**. The builder was careful to say that is a bench shape, not the running studio. Its test drives the handler against a still-open upstream stream, so a return to buffering HANGS rather than passing quietly — a test that fails in the right direction.

**Director review**: confirmed this is not the twice-rejected streamed-playback idea — the player is untouched and the studio still awaits `res.blob()`, so the take, its peaks and its download are byte-for-byte what they were. Only the proxy's memory changes. Gates on main: tsc clean, 170 at merge. MERGED.
