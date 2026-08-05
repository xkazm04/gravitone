// Audition proxy: POST a candidate stem + a line, get back a WAV of the CLONE
// speaking it (never the source audio — that is the /preview route).
//
// Not `proxyJson` (the response is audio, not JSON) and not `proxyWavPost` (that
// one caps a synthesis body and forwards a fixed header allowlist). What this
// path needs is its own: a long budget, because one audition is a cold CPU model
// load plus a line of synthesis; the upstream status passed straight through, so
// the studio's 429 backpressure path keeps working; and the X-Audition-* meta
// forwarded, so the player can say what is playing without a second round trip.
import { NextRequest } from "next/server";
import { backendFetch, jsonError, readCappedText } from "@/lib/backend";

// One cold model load (~15s) + one line on the CPU engine. The service's own
// audition timeout is 240s and answers with a named failure; sit just above it so
// this proxy never hides that answer behind a generic abort.
const AUDITION_TIMEOUT_MS = 250_000;
// A JSON body of {emotion, recipe, text}: the service caps the line at 240 chars,
// so anything near this is not a request we should be relaying.
const MAX_BODY_BYTES = 4 * 1024;
// The meta the service states about what it just synthesized.
const META_HEADERS = [
  "X-Audition-Emotion", "X-Audition-Recipe",
  "X-Audition-Seconds", "X-Audition-Source-Seconds",
] as const;

export async function POST(req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  const body = await readCappedText(req, MAX_BODY_BYTES);
  if (body instanceof Response) return body;

  let upstream: Response;
  try {
    upstream = await backendFetch(
      `/v1/ingest/${encodeURIComponent(job)}/audition`,
      {
        credential: "operator",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(AUDITION_TIMEOUT_MS),
      },
    );
  } catch {
    return jsonError("backend unreachable", 503);
  }

  if (!upstream.ok) {
    // Status AND Retry-After passed through: a full audition budget must reach
    // the studio as backpressure (amber, retryable), not as a failure.
    const headers = new Headers({ "Content-Type": "application/json" });
    const retryAfter = upstream.headers.get("Retry-After");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    return new Response(await upstream.text(), { status: upstream.status, headers });
  }

  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") ?? "audio/wav",
    // A candidate is regenerated on demand and scratch-deleted server-side;
    // there is nothing here to cache, and caching it would outlive the job.
    "Cache-Control": "no-store",
  });
  for (const h of META_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Streamed, like the other audio relays: the clip is never held whole here.
  return new Response(upstream.body, { status: 200, headers });
}
