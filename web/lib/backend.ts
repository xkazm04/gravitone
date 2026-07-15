// Server-side helper for calls to the Gravitone TTS backend. Attaches the
// root API key (GRAVITONE_API_KEY in .env.local) so the key-protected
// backend accepts the studio's proxy requests; without a key configured the
// call goes out bare, matching an unprotected local backend.
// Server-only — never import from client components.

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

/** Consistent JSON error body for the proxy routes. The backend speaks JSON
 *  ({detail: …}); returning a plain-text error from a route breaks a
 *  JSON-parsing (ElevenLabs drop-in) client that reads every response as JSON. */
export function jsonError(detail: string, status: number): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** POST a JSON body to a synthesis endpoint and return its WAV.
 *
 *  Shared by /api/speak and /api/performance, which were byte-identical apart
 *  from the upstream path and their forwarded-header allowlist. Handles the
 *  body cap, the 503 on an unreachable backend, the upstream-status passthrough
 *  (so a 429 stays a 429 and carries Retry-After for the client's backoff), and
 *  the header allowlist on success. Any hardening applied here now reaches both.
 */
export async function proxyWavPost(
  req: Request,
  backendPath: string,
  forwardHeaders: readonly string[],
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
    return new Response("backend unreachable", { status: 503 });
  }

  if (!upstream.ok) {
    const headers = new Headers();
    const retryAfter = upstream.headers.get("Retry-After");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    return new Response(await upstream.text(), { status: upstream.status, headers });
  }

  const headers = new Headers({ "Content-Type": "audio/wav" });
  for (const h of forwardHeaders) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
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
    if (!r.ok) return new Response("not found", { status: r.status });
    return new Response(r.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "private, max-age=3600, immutable",
      },
    });
  } catch {
    return new Response("backend unreachable", { status: 503 });
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
