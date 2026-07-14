// Multi-character performance: a directed script of {character_id, text} lines
// synthesized in one call, Voices switching per character AND per emotion. The
// backend concatenates every line into one WAV and returns the full per-line /
// per-segment substitution report base64-JSON in X-Performance-Report. Mirrors
// /api/speak: the backend URL + key stay server-side, timing + report headers
// are forwarded, and 429 backpressure is preserved (never flattened away).
import { NextRequest } from "next/server";

import { backendFetch, readCappedText } from "@/lib/backend";

const FORWARD_HEADERS = [
  "X-Audio-Seconds",
  "X-Realtime-Factor",
  "X-Synth-Seconds",
  "X-Queue-Seconds",
  "X-Ignored-Settings",
  "X-Performance-Report",
] as const;

export async function POST(req: NextRequest) {
  const body = await readCappedText(req);
  if (body instanceof Response) return body;

  let upstream: Response;
  try {
    upstream = await backendFetch(`/v1/performance`, {
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
  for (const h of FORWARD_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(await upstream.arrayBuffer(), { status: 200, headers });
}
