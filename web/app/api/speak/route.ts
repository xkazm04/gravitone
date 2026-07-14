// Metatag-aware speech: one Character, Voices switched per emotion, baseline
// fallback. Forwards the per-segment report AND the honest timing / ignored-
// settings headers so the UI can show what actually ran, and preserves the
// upstream status (429 backpressure, Retry-After) instead of flattening every
// failure into one browser-voice fallback.
import { NextRequest } from "next/server";

import { backendFetch, readCappedText } from "@/lib/backend";

// Upstream response headers we surface to the browser. Timing (synth/queue),
// realtime factor, the base64 per-segment report, and any accepted-but-inert
// voice settings — each only forwarded when the backend actually sent it.
const FORWARD_HEADERS = [
  "X-Audio-Seconds",
  "X-Realtime-Factor",
  "X-Synth-Seconds",
  "X-Queue-Seconds",
  "X-Ignored-Settings",
  "X-Segments",
] as const;

export async function POST(req: NextRequest) {
  const body = await readCappedText(req);
  if (body instanceof Response) return body;

  let upstream: Response;
  try {
    upstream = await backendFetch(`/v1/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }

  if (!upstream.ok) {
    // Preserve the upstream status so the client can tell 429 "engine busy,
    // retry" apart from a hard failure — and carry Retry-After through so the
    // retry can honour the backend's backoff hint.
    const headers = new Headers();
    const retryAfter = upstream.headers.get("Retry-After");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    return new Response(await upstream.text(), { status: upstream.status, headers });
  }

  const headers = new Headers({ "Content-Type": "audio/wav" });
  for (const h of FORWARD_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(await upstream.arrayBuffer(), { status: 200, headers });
}
