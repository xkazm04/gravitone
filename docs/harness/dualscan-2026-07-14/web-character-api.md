# Dual-lens scan — web-character-api
> Files: 8 | Findings: 5 (crit 0 / high 2 / med 3 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Privileged proxy routes have no auth gate; root backend key is attached server-side
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: trust-boundary / missing-auth
- **File**: `web/lib/backend.ts:12` (consumed by every route, e.g. `web/app/api/voices/[id]/route.ts:27`)
- **Scenario**: `backendFetch` unconditionally injects the root `GRAVITONE_API_KEY` (full-privilege service key) onto every upstream call. None of the 8 Next route handlers perform any authn/authz of the *caller* before proxying. If the studio is bound to anything but loopback (LAN, a shared dev box, or a container with an exposed port), any client can call `DELETE /api/voices/{id}`, `DELETE /api/characters/{id}`, `POST /api/characters/import`, or `POST /api/voices` and it executes with root privilege. The multipart POSTs (clone / import) use `multipart/form-data`, a CORS "simple" content-type, so they are also reachable via cross-site CSRF from any page the user opens in the same browser — no preflight, no auth, no CSRF token.
- **Root cause**: The design pushes all auth to the backend via a single shared root key, then puts an unauthenticated open proxy in front of it. The web tier re-grants the root key to every anonymous request instead of scoping/forwarding a per-user credential.
- **Impact**: Unauthenticated destructive actions (voice/character deletion, forced imports, model-loading clones) whenever the app is reachable beyond localhost, plus a CSRF path for the state-changing POSTs even on localhost.
- **Fix sketch**: Add a shared auth check (session cookie or a studio-scoped token) in the route handlers before calling `backendFetch`, and forward a *scoped* key rather than the root key. For the POST routes, require a same-origin/CSRF check (verify `Origin`/`Sec-Fetch-Site`).

## 2. 5xx error bodies are inconsistently plain-text vs JSON, breaking JSON-parsing clients
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: silent-failure / response-contract
- **File**: `web/app/api/voices/route.ts:9`
- **Scenario**: When the backend is down or errors, half these routes return a **plain-text** body — `voices/route.ts:9` `"upstream error"` (502), `characters/route.ts:12` `"backend unreachable"` (503), `characters/[id]/route.ts:12`, `voices/[id]/route.ts:20` — with no `Content-Type` (defaults to `text/plain`). The other half return **JSON** — `emotions/route.ts:15` and `import/route.ts:12` return `{"detail":"backend unreachable"}` with `Content-Type: application/json`. Every *success* path sets `application/json`. A client that does the natural `if (!res.ok) { const {detail} = await res.json() }` throws a `SyntaxError` on the plain-text routes exactly when the backend fails — turning a recoverable "backend down" state into an unhandled client crash.
- **Root cause**: No single error-envelope contract; each file was written ad hoc, so the failure shape differs per route while clients assume one shape.
- **Impact**: The error-handling branch (the branch that matters most) is the one most likely to crash the studio UI; users get a blank/broken screen instead of "backend unreachable."
- **Fix sketch**: Standardize every error response on `Response.json({ detail }, { status })` (JSON body + matching content-type) across all 8 files; ideally centralize it (see finding 5).

## 3. Character/voice DELETE handlers discard the upstream error body, hiding 409 reasons
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: silent-failure
- **File**: `web/app/api/characters/[id]/route.ts:37`
- **Scenario**: The DELETE handlers return `new Response(null, { status: r.status })` (`characters/[id]/route.ts:37`, `voices/[id]/route.ts:30`). The backend legitimately returns non-2xx with an explanatory body — e.g. a 409 when a Voice still occupies an emotion slot / a Character is referenced (the sibling `emotions/[emotion]/route.ts:1` comment confirms the backend 409s with a reason). By hardcoding a `null` body, that reason is dropped: the client sees a bare 409/4xx with an empty body and cannot tell the user *why* the delete failed. Note the emotion DELETE route deliberately forwards the body on non-204 (`emotions/[emotion]/route.ts:13`), so this is an inconsistency, not a chosen convention.
- **Root cause**: The handler optimizes for the 204 success case and assumes DELETE never returns a meaningful body, ignoring the backend's documented conflict responses.
- **Impact**: Delete conflicts (the common failure) surface as an unexplained error; users retry blindly or think the app is broken.
- **Fix sketch**: On non-2xx, forward the upstream body and status like the emotions route does: `if (!r.ok) return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } })`; only return `null` for 204.

## 4. Upload timeouts are reported as "backend unreachable"
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: silent-failure / logging-lie
- **File**: `web/app/api/voices/route.ts:26`
- **Scenario**: The clone POST sets `AbortSignal.timeout(300_000)` (`voices/route.ts:26`) and import sets `120_000` (`import/route.ts:8`). When a genuinely slow operation exceeds the deadline, the abort throws and is caught by the same bare `catch` that returns 503 `"backend unreachable"` (`voices/route.ts:33`). But the backend *was* reached and is very likely still running the clone/import to completion server-side. The user is told the backend is down (implying "retry / nothing happened"), so they re-upload — spawning a second expensive model-load/import — while the first silently succeeds, producing duplicate voices/characters.
- **Root cause**: One catch-all block collapses three distinct outcomes (connection refused, request timeout, local `formData()` parse error) into a single misleading "unreachable" message.
- **Impact**: Misdiagnosed failures, duplicate/orphaned work from user retries, and wasted GPU/model-load time on long operations.
- **Fix sketch**: Distinguish `err.name === "TimeoutError"`/`AbortError` and return `504` with a "still processing, do not retry" message; keep 503 only for actual connect failures.

## 5. Twelve near-identical proxy handlers duplicated across all 8 files
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/app/api/characters/[id]/route.ts:5`
- **Scenario**: Every handler in these 8 files repeats the same skeleton: `await ctx.params` → build the `/v1/...` path with `encodeURIComponent` → `backendFetch` → `try { return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } }) } catch { return <503> }`. It appears ~12 times (`characters/route.ts`, `characters/[id]/route.ts` ×3, `emotions/route.ts`, `emotions/[emotion]/route.ts`, `pack/route.ts`, `import/route.ts`, `voices/route.ts` ×2, `voices/[id]/route.ts` ×2). Because it is copy-pasted, the copies have already drifted — the error-body format (finding 2), the DELETE body handling (finding 3), and the timeout labeling (finding 4) all diverge between otherwise-identical handlers.
- **Root cause**: No shared proxy primitive; each route reimplements JSON passthrough and error handling by hand, so fixes must be applied 12 times and inevitably miss copies.
- **Impact**: Maintainability debt and a bug-multiplier — the divergences in findings 2–4 are a direct symptom of the duplication.
- **Fix sketch**: Extract a `proxyJson(path, init)` helper (and a `proxyStream` variant for `pack/route.ts`) in `web/lib/backend.ts` that owns the try/catch, the standardized JSON error envelope, and status/body forwarding; reduce each handler to a one-line call. Fixing findings 2–4 there fixes them everywhere.
