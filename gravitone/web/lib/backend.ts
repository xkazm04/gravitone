// Server-side helper for calls to the Gravitone TTS backend.
// Server-only — never import from client components.
//
// THE CREDENTIAL IS NEVER IMPLICIT. `GRAVITONE_API_KEY` is the backend's ROOT
// key: service/auth.py passes it for every scope check, `admin` included, so a
// request carrying it can mint, enumerate and revoke API keys. It used to be
// attached to EVERY outbound call automatically, which meant a route acquired
// admin authority by existing — the `/api/keys` proxies inherited the crown
// jewels while performing no authorization of their own, and any anonymous
// caller who could reach the studio could mint themselves a backend key.
//
// So the default is now nothing, and each call site NAMES what it presents.
// The choice is a required field, not an optional flag: a new route cannot be
// written without answering the question, and `tsc` is what asks.

import { forwardExposedHeaders } from "@/lib/serviceHeaders";

const BASE = process.env.GRAVITONE_URL ?? "http://127.0.0.1:8080";

/** Which credential the studio presents to the backend on ONE call.
 *
 *  `"operator"` — `GRAVITONE_API_KEY`, the deployment's root key. Unlimited
 *    upstream. Correct for the studio's own proxy routes (every backend router
 *    sits behind `require_scope(...)`, and the root key is the only credential
 *    this process holds), but it is authority the ROUTE is then responsible
 *    for rationing: whatever the route lets an anonymous caller ask for, it is
 *    asking with admin rights. Routes that reach a privileged surface
 *    (`/api/keys/**`) authorize the caller FIRST — see app/api/keys/identity.ts.
 *
 *  `"none"` — no credential at all. For the proving route, whose whole
 *    measurement is what this deployment does with an unauthenticated request
 *    (or one carrying only the key under test). A root key attached here would
 *    prove the root key works and nothing else. */
export type BackendCredential = "operator" | "none";

export type BackendInit = RequestInit & { credential: BackendCredential };

export async function backendFetch(path: string, init: BackendInit): Promise<Response> {
  const { credential, ...rest } = init;
  const headers = new Headers(rest.headers);
  const key = process.env.GRAVITONE_API_KEY;
  if (credential === "operator" && key && !headers.has("xi-api-key")) {
    headers.set("xi-api-key", key);
  }
  await forwardCallerAddress(headers);
  return fetch(`${BASE}${path}`, { ...rest, headers });
}

/** Pass the CALLER's address through to the service's per-IP limiter.
 *
 *  service/ratelimit.py budgets the public compute surfaces per client, and it
 *  identifies a client as the direct peer unless `X-Forwarded-For` is present
 *  AND `TTS_TRUST_PROXY` is on. Every request that arrives through this studio
 *  has the same direct peer — this process — so with nothing forwarded, all
 *  users of a deployment share ONE bucket: one busy studio user exhausts the
 *  budget for everyone beside them, and a scripted caller is limited no more
 *  than an honest one. Exactly one route (`/t/[id]/reperform`) forwarded the
 *  header, so exactly one surface was actually limited per caller.
 *
 *  It lives HERE rather than in each route because the per-route version is the
 *  one that gets forgotten — this is the single door every proxy leaves by.
 *
 *  PASSED, never trusted: the service decides whether to honour it
 *  (`TTS_TRUST_PROXY`) and which hop of it is the caller (`TTS_TRUSTED_HOPS`,
 *  counted from the right, because a client can forge the left). A studio with
 *  no reverse proxy in front of it receives no such header and forwards none,
 *  which is exactly what it did before.
 *
 *  `headers()` throws outside a request scope — a unit test calling a handler
 *  directly, a build-time render. That is not an error; it is the absence of a
 *  caller, so nothing is forwarded. */
async function forwardCallerAddress(out: Headers): Promise<void> {
  if (out.has("x-forwarded-for")) return; // an explicit call-site choice wins
  try {
    const { headers } = await import("next/headers");
    const xff = (await headers()).get("x-forwarded-for");
    if (xff) out.set("x-forwarded-for", xff);
  } catch {
    /* no request scope — there is no caller address to forward */
  }
}

// The synthesis relays (/api/speak, /api/performance, /api/tts) are the app's
// unauthenticated compute surface: each call can tie up a synth slot for up to
// ~3 minutes. Cap the request body so a single caller can't hand the backend an
// oversized payload. ~128k chars of script is far beyond any real use.
export const MAX_SYNTH_BODY_BYTES = 128 * 1024;

// Read/SSR timeout. A backend that accepts the TCP connection but never answers
// (overloaded synth queue, half-open socket) would otherwise pin an SSR worker
// or route handler open until the platform's hard timeout. Bound the read GETs
// so they fail fast into the existing unreachable branch (503 / notFound).
export const READ_TIMEOUT_MS = 15_000;

// Mutations that are pure metadata ops (no synthesis, no upload) get this
// generous default; slow paths (clone, scan, import) pass their own budget.
export const WRITE_TIMEOUT_MS = 30_000;

/** Consistent JSON error body for the proxy routes. The backend speaks JSON
 *  ({detail: …}); returning a plain-text error from a route breaks a
 *  JSON-parsing (ElevenLabs drop-in) client that reads every response as JSON. */
export function jsonError(detail: string, status: number): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Proxy one JSON-speaking backend call: status passthrough, body passthrough,
 *  Retry-After preserved (backpressure must survive the proxy), one JSON
 *  unreachable shape, and a timeout on every call.
 *
 *  This is the missing half of the consolidation that produced proxyWavPost:
 *  before it, 20 of 26 routes hand-rolled try/fetch/catch with five divergent
 *  error dialects — plain-text 503s that broke JSON-parsing clients, upstream
 *  statuses collapsed to generic 502s (destroying the 429 busy-vs-broken
 *  signal), and 204/no-body handling that dropped backend error details. */
export async function proxyJson(
  path: string,
  init: RequestInit & { timeoutMs?: number; credential: BackendCredential },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const method = (rest.method ?? "GET").toUpperCase();
  const defaultMs = method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
  let r: Response;
  try {
    r = await backendFetch(path, {
      cache: "no-store",
      ...rest,
      signal: AbortSignal.timeout(timeoutMs ?? defaultMs),
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
  if (r.status === 204 || r.status === 304) {
    return new Response(null, { status: r.status });
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  const retryAfter = r.headers.get("Retry-After");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return new Response(await r.text(), { status: r.status, headers });
}

/** POST a JSON body to a synthesis endpoint and return its audio.
 *
 *  Shared by /api/speak and /api/performance, which were byte-identical apart
 *  from the upstream path and their forwarded-header allowlist. Handles the
 *  body cap, the 503 on an unreachable backend, the upstream-status passthrough
 *  (so a 429 stays a 429 and carries Retry-After for the client's backoff), and
 *  the header forwarding on success. Any hardening applied here now reaches both.
 *
 *  Headers come from ONE list (lib/serviceHeaders) rather than a per-route
 *  literal — see that module for why three hand-kept subsets was the bug.
 *
 *  `forwardQuery` names the query parameters a caller may pass THROUGH to the
 *  service (`output_format` today). It lives here rather than in one route
 *  because both premium routes gained the same format grammar in the service;
 *  a route that forwards nothing builds exactly the URL it built before.
 */
export async function proxyWavPost(
  req: Request,
  backendPath: string,
  opts: { credential: BackendCredential; forwardQuery?: readonly string[] },
): Promise<Response> {
  const body = await readCappedText(req);
  if (body instanceof Response) return body;
  return proxyAudioPost(withForwardedQuery(req.url, backendPath, opts.forwardQuery), body, {
    credential: opts.credential,
  });
}

/** POST a JSON body to a synthesis endpoint and relay its audio, streaming.
 *
 *  The half of proxyWavPost that does not care where the body came from — split
 *  out for /api/speak/stream, whose upstream PATH carries the voice address and
 *  whose body is rebuilt rather than forwarded. Splitting it (rather than
 *  writing a second relay) is what keeps ONE answer to the non-OK passthrough,
 *  the Retry-After preservation, the header allowlist and the 503 shape.
 */
export async function proxyAudioPost(
  backendPath: string,
  body: string,
  opts: { credential: BackendCredential; timeoutMs?: number },
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await backendFetch(backendPath, {
      credential: opts.credential,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }

  if (!upstream.ok) {
    const headers = new Headers({ "Content-Type": "application/json" });
    const retryAfter = upstream.headers.get("Retry-After");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    return new Response(await upstream.text(), { status: upstream.status, headers });
  }

  // The response says what it ACTUALLY is. Hardcoding audio/wav mislabelled an
  // mp3 the caller explicitly asked for, and a mislabelled blob is one a
  // browser may refuse to decode and a download that saves under a lie.
  const headers = forwardExposedHeaders(
    upstream.headers,
    new Headers({ "Content-Type": upstream.headers.get("Content-Type") ?? "audio/wav" }),
  );
  // STREAM, don't buffer. `await upstream.arrayBuffer()` held the entire take in
  // this process before writing a byte of it — and the largest thing this
  // product makes (a 64-line performance) is held on the same box that just
  // spent its RAM synthesizing it. The sibling helper below has always streamed;
  // this is the same shape.
  //
  // For /v1/speak this is memory only: the studio awaits res.blob() before the
  // take joins the log. For /api/speak/stream it is the whole feature — the
  // first PCM chunk has to reach the browser while the engine is still
  // synthesizing the rest, so anything that buffers here defeats it.
  return new Response(upstream.body, { status: 200, headers });
}

/** `backendPath` plus the allowlisted query parameters the caller supplied.
 *  Returns `backendPath` UNCHANGED when nothing is allowlisted or nothing was
 *  passed, so an existing caller's upstream URL is byte-identical. */
function withForwardedQuery(
  reqUrl: string,
  backendPath: string,
  allow?: readonly string[],
): string {
  if (!allow?.length) return backendPath;
  const incoming = new URL(reqUrl).searchParams;
  const out = new URLSearchParams();
  for (const key of allow) {
    const v = incoming.get(key);
    if (v !== null) out.set(key, v);
  }
  const qs = out.toString();
  if (!qs) return backendPath;
  return `${backendPath}${backendPath.includes("?") ? "&" : "?"}${qs}`;
}

/** Stream an immutable ingest audio asset (a stem, segment or speaker preview).
 *
 *  Shared by the three ingest asset routes, which differed only in their
 *  upstream path segment. Streams the body rather than buffering it, and caches:
 *  these wavs are written once and never change.
 *
 *  A REFUSAL is passed through exactly as proxyJson passes one: the upstream
 *  status, the upstream body, and Retry-After. This proxy used to flatten every
 *  non-OK answer to `{"detail":"not found"}` — which threw away the four
 *  distinguished sentences the service writes about a segment it will not serve
 *  (`ingest_api.py::_segment_refusal`: "measured as not the target speaker",
 *  "could not be decoded", …), the "job not found or expired" that means the
 *  whole session is gone, and any Retry-After on the way. It was the one proxy
 *  in the app that did this.
 */
export async function streamIngestAsset(
  upstreamPath: string,
  opts: { credential: BackendCredential },
): Promise<Response> {
  try {
    const r = await backendFetch(upstreamPath, {
      credential: opts.credential,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!r.ok) {
      const headers = new Headers({ "Content-Type": "application/json" });
      const retryAfter = r.headers.get("Retry-After");
      if (retryAfter) headers.set("Retry-After", retryAfter);
      const body = await r.text();
      // An upstream that says nothing still gets a body the client can read:
      // readDetail must never be handed an empty response to parse.
      return body
        ? new Response(body, { status: r.status, headers })
        : jsonError("not found", r.status);
    }
    return new Response(r.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "private, max-age=3600, immutable",
      },
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
}

/** Read a request body as text, rejecting oversize payloads early with a 413.
 *  Returns the body string, or a Response the caller should return as-is. */
export async function readCappedText(
  req: Request,
  maxBytes: number = MAX_SYNTH_BODY_BYTES,
): Promise<string | Response> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    return new Response("request body too large", { status: 413 });
  }
  const body = await req.text();
  if (new TextEncoder().encode(body).length > maxBytes) {
    return new Response("request body too large", { status: 413 });
  }
  return body;
}
