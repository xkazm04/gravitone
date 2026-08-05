// Server-side proxy to the Gravitone TTS backend. Keeps the browser free of
// CORS issues and hides the endpoint. Set GRAVITONE_URL to point at a running
// service (local :8080 by default, or your deployed Arm instance).
import { NextRequest } from "next/server";
import { backendFetch, jsonError, readCappedText } from "@/lib/backend";
import { forwardExposedHeaders } from "@/lib/serviceHeaders";

// playground voice-id → backend voice-id (cloned demo voice lives as step4)
const VOICE_MAP: Record<string, string> = { mine: "step4" };

// A single utterance — far smaller than a multi-line performance script.
const MAX_TTS_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const raw = await readCappedText(req, MAX_TTS_BODY_BYTES);
  if (raw instanceof Response) return raw;

  let body: { text?: string; voiceId?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError("bad request", 400);
  }
  const text = (body.text ?? "").trim();
  const voiceId = VOICE_MAP[body.voiceId ?? ""] ?? body.voiceId ?? "alba";
  if (!text) return jsonError("empty text", 400);

  try {
    const upstream = await backendFetch(
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav_24000`,
      {
        credential: "operator",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: "pocket_tts" }),
        signal: AbortSignal.timeout(120_000),
      }
    );
    if (!upstream.ok) {
      // Status + body passthrough. The old `upstream ${status}` → 502 rewrite
      // destroyed the backpressure signal: a 429 queue-full (with Retry-After)
      // and a hard 500 both read as "broken" to every caller of this route.
      const headers = new Headers({ "Content-Type": "application/json" });
      const retryAfter = upstream.headers.get("Retry-After");
      if (retryAfter) headers.set("Retry-After", retryAfter);
      return new Response(await upstream.text(), { status: upstream.status, headers });
    }
    const buf = await upstream.arrayBuffer();
    // Same forwarding as the premium routes, from the same list. The old
    // two-header literal dropped X-Cache — which ONLY this upstream route emits
    // — and wrote "" for a header the backend had not sent, so a client read an
    // empty string where it should have read null.
    return new Response(buf, {
      status: 200,
      headers: forwardExposedHeaders(
        upstream.headers, new Headers({ "Content-Type": "audio/wav" })),
    });
  } catch {
    // backend unreachable — signal the client to use its browser-speech fallback
    return jsonError("backend unreachable", 503);
  }
}
