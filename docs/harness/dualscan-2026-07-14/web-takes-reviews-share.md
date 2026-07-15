# Dual-lens scan — web-takes-reviews-share
> Files: 12 | Findings: 5 (crit 0 / high 1 / med 4 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Share-card OG image is a relative URL with no metadataBase — every social preview breaks
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: broken-share / missing-config
- **File**: `web/app/t/[id]/page.tsx:31`
- **Scenario**: A user copies a `/t/<id>` link (the whole product loop — "every share is a landing page") and pastes it into Slack, X, LinkedIn, or iMessage. The crawler reads `openGraph.images: ["/emotions/<emotion>.png"]`, a root-relative path.
- **Root cause**: Next.js resolves relative metadata image URLs against `metadataBase`, but it is set nowhere — root `web/app/layout.tsx:14` defines `metadata` without it, and a repo-wide grep for `metadataBase` returns zero matches. Without it Next falls back to `http://localhost:3000` (dev) or an unreliable inferred origin, and logs a warning at build.
- **Impact**: The emotion-glyph preview image — the visual hook that sells the metatag differentiator on every shared link — points at `localhost` / an unresolvable host, so external platforms show no image (or a broken one). The share and the client-review OG cards render blank previews for exactly the audience shares are meant to convert.
- **Fix sketch**: Add `metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000")` to the root `metadata` in `layout.tsx`, and/or make the OG image an absolute URL. Same fix protects the `r/[id]` metadata path.

## 2. Object-URL leak when TakeCard unmounts mid-fetch (tab-switching a review)
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: resource-leak / race-condition
- **File**: `web/app/t/[id]/TakeCard.tsx:57`
- **Scenario**: In `ReviewPicker` only the active take's `TakeCard` is mounted (`key={take.id}`), so clicking through 2–6 take tabs before each audio blob finishes downloading unmounts one card mid-fetch. The audio `fetch` for the just-closed card resolves after unmount: the async body runs `url = URL.createObjectURL(blob)` (line 57) and only then hits `if (!alive) return` (line 58).
- **Root cause**: The cleanup `if (url) URL.revokeObjectURL(url)` already ran at unmount when `url` was still `null`; the URL is created afterwards, so nothing ever revokes it. The `!alive` early-return path leaks the object URL it just minted.
- **Impact**: Each interrupted load leaks one decoded-wav blob URL (hundreds of KB each) that lives until the tab closes. A reviewer flipping through takes, or a busy embed grid, steadily grows browser memory.
- **Fix sketch**: Revoke in the abort path — `if (!alive) { URL.revokeObjectURL(url); return; }` — or defer `createObjectURL` until after the `alive` check, or store the URL in a ref the cleanup always reads.

## 3. Read proxies and SSR loads have no request timeout — a slow (not down) backend hangs the route
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: silent-failure / missing-timeout
- **File**: `web/app/api/takes/[id]/audio/route.ts:8`
- **Scenario**: The backend accepts the TCP connection but stalls (overloaded CPU synth queue, half-open socket). The audio proxy `backendFetch('/v1/takes/<id>/audio')` — and equally `api/takes/[id]/route.ts:8` and the SSR `loadTake`/`loadReview` in `t/[id]/page.tsx:13` and `r/[id]/page.tsx:13` — awaits with no `signal`/timeout.
- **Root cause**: Only the write path sets a bound (`AbortSignal.timeout(60_000)` in `api/takes/route.ts:8`); every read/SSR path omits it. The `catch` blocks only handle *connection* failures ("backend unreachable"), not a connection that never answers.
- **Impact**: A stuck backend pins server-rendering workers and API route handlers open until the platform's hard timeout, degrading or exhausting concurrency for all visitors rather than failing fast with a clean 503/404.
- **Fix sketch**: Pass `signal: AbortSignal.timeout(15_000)` (or similar) to the GET `backendFetch` calls and the SSR loaders; on `AbortError` return 503 / `notFound()` as the unreachable branches already do.

## 4. Take-loading logic is triplicated across share page, embed page, and metadata proxy
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/app/t/[id]/embed/page.tsx:12`
- **Scenario**: `embed/page.tsx:12-15` reimplements the exact `backendFetch('/v1/takes/<id>', {cache:"no-store"})` → `r.ok ? json : null` → `catch → null` block that already exists as `loadTake` in `t/[id]/page.tsx:11-18`; `api/takes/[id]/route.ts:5-13` proxies the same call a third time.
- **Root cause**: No shared take-fetch helper, so each consumer inlines the URL, cache mode, and error handling independently.
- **Impact**: Any change (adding the timeout from finding #3, altering the endpoint or cache policy, handling a new backend shape) must be made in three places and will silently drift — the embed page and share page can diverge on how a missing take is treated.
- **Fix sketch**: Extract `loadTake(id): Promise<SharedTake | null>` into `web/lib/takes.ts` and import it from both `t/[id]/page.tsx` and `t/[id]/embed/page.tsx`; the `api/takes/[id]` proxy can share the same base call.

## 5. Public write proxies launder the backend API key onto unauthenticated callers
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: trust-boundary
- **File**: `web/app/api/takes/route.ts:4`
- **Scenario**: An anonymous internet caller POSTs a multipart body to `/api/takes` (persist a wav take) or JSON to `/api/reviews` / `/api/reviews/[id]/pick`. These routes do no auth check and no rate limiting, then call `backendFetch`, which attaches `xi-api-key` (`web/lib/backend.ts:12`) — so the request reaches the key-protected backend as an authorized write.
- **Root cause**: The app has an auth system (`AuthProvider`/`useAuth` in the root layout, a `keys` route), but the take/review *creation* proxies opt out of it entirely. The server-held API key is the backend's only gate, and the proxy hands that access to any unauthenticated request. The 60s accept window on `/api/takes` also allows large uploads.
- **Impact**: Storage/compute abuse — an attacker can spam-persist takes and reviews against the studio's backend budget, or flood picks, with no cost or identity. (Reviewer *picks* are intentionally login-less, but take/review creation writing to shared storage is not obviously meant to be open.)
- **Fix sketch**: Gate `POST /api/takes` and `POST /api/reviews` behind the existing session auth (or a scoped token) and/or add per-IP rate limiting and a request-size cap; keep only the reviewer-pick surface anonymous by design.
