---
slug: browser-usable-api
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: feature
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 0e4d82f
---
## What & why
"Drop-in ElevenLabs compatibility" is the product's headline claim, and there is no CORS middleware anywhere in the repo. Every browser client — including ElevenLabs' own JS SDK — fails at the preflight. Only the Next.js server-side proxy can talk to the service, which means the compatibility story holds precisely for the callers who do not need it.

## Evidence
- No `add_middleware` / `CORSMiddleware` anywhere in `gravitone/` (scout grep, Director-confirmed by the absence of any import in `service/app.py`).
- `service/app.py:82` — the app is constructed with no middleware and FastAPI's default docs URLs.
- The service publishes meaningful custom headers a client is meant to read: `X-Cache` (`app.py:806`), `X-Synth-Seconds`/`X-Queue-Seconds`/`X-Realtime-Factor` (`:846-848`), `X-Segments` (`:1118`), `X-Ignored-Settings` — all invisible to browser JS without `expose_headers` even when the request succeeds.

## Acceptance criteria
- CORS is configured with an EXPLICIT, configurable origin policy — not a blanket wildcard on a service that also mounts `/v1/keys` and `/v1/ingest`.
- `expose_headers` covers the custom headers a client is meant to read, so a successful browser request can actually see them.
- Preflight is handled for the methods and headers the API really uses (`xi-api-key`, `Authorization`, `Content-Type`).
- A test asserts both the preflight response and the exposed header set.
- The default posture is documented: what an operator must set to allow their own origin, and what happens if they set nothing.

## Risks / non-goals
- A permissive default here would be a security regression, not a feature — the same service exposes key management. Default to closed/explicit and say so.
- Non-goal: authentication changes, or the missing EL routes (`/v1/user`, `/v1/history`, timestamps) — this is about making the EXISTING surface reachable.

## Build record
Builder S2. `cors_policy(settings)` returns CORSMiddleware kwargs or `None`. **Default CLOSED**: with no `TTS_CORS_ORIGINS`/`TTS_CORS_ORIGIN_REGEX` the middleware is not installed at all, so behaviour is byte-identical to before (server-to-server and the Next proxy unaffected). Knobs: `TTS_CORS_ORIGINS`, `TTS_CORS_ORIGIN_REGEX`, `TTS_CORS_ALLOW_CREDENTIALS` (off), `TTS_CORS_MAX_AGE`. `"*"` is opt-in and logged as a startup warning; combined with credentials the credentials flag is dropped (invalid per spec) with a second warning. `expose_headers` covers all 17 custom headers plus `Retry-After`.

Standout: a **drift guard** test greps every `"X-…"` literal in `app.py` and fails if it is not in `CORS_EXPOSE_HEADERS`. The sibling builder added headers to `/v1/speak` in the same wave and the guard held — a test that protects the class of bug, not the instance.

**Director review**: the brief's hard line was "default closed — a wildcard on a service that also mounts `/v1/keys` and `/v1/ingest` is a security regression dressed as a feature", and the builder honoured it exactly. Verified `cors_policy` returns None with no config. Gates on main: 447 at merge, 469 after the wave. MERGED.
