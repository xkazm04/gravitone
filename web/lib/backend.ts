// Server-side helper for calls to the Gravitone TTS backend. Attaches the
// root API key (GRAVITONE_API_KEY in .env.local) so the key-protected
// backend accepts the studio's proxy requests; without a key configured the
// call goes out bare, matching an unprotected local backend.
// Server-only — never import from client components.

import { forwardExposedHeaders } from "@/lib/serviceHeaders";

const BASE = process.env.GRAVITONE_URL ?? "http://127.0.0.1:8080";

export function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const key = process.env.GRAVITONE_API_KEY;
  if (key && !headers.has("xi-api-key")) headers.set("xi-api-key", key);
  return fetch(`${BASE}${path}`, { ...init, headers });
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
  init: RequestInit & { timeoutMs?: number } = {},
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
 */
export async function proxyWavPost(
  req: Request,
  backendPath: string,
): Promise<Response> {
  const body = await readCappedText(req);
  if (body instanceof Response) return body;

  let upstream: Response;
  try {
    upstream = await backendFetch(backendPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(180_000),
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

  const headers = forwardExposedHeaders(
    upstream.headers, new Headers({ "Content-Type": "audio/wav" }));
  return new Response(await upstream.arrayBuffer(), { status: 200, headers });
}

/** Stream an immutable ingest audio asset (a stem or speaker preview) through.
 *
 *  Shared by the two ingest preview routes, which differed only in their
 *  upstream path segment. Streams the body rather than buffering it, and caches:
 *  these wavs are written once and never change.
 */
export async function streamIngestAsset(upstreamPath: string): Promise<Response> {
  try {
    const r = await backendFetch(upstreamPath, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!r.ok) return jsonError("not found", r.status);
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
