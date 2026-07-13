// Server-side proxy to the Gravitone TTS backend. Keeps the browser free of
// CORS issues and hides the endpoint. Set GRAVITONE_URL to point at a running
// service (local :8080 by default, or your deployed Arm instance).
import { NextRequest } from "next/server";
import { backendFetch } from "@/lib/backend";

// playground voice-id → backend voice-id (cloned demo voice lives as step4)
const VOICE_MAP: Record<string, string> = { mine: "step4" };

export async function POST(req: NextRequest) {
  let body: { text?: string; voiceId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const text = (body.text ?? "").trim();
  const voiceId = VOICE_MAP[body.voiceId ?? ""] ?? body.voiceId ?? "alba";
  if (!text) return new Response("empty text", { status: 400 });

  try {
    const upstream = await backendFetch(
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav_24000`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: "pocket_tts" }),
        signal: AbortSignal.timeout(120_000),
      }
    );
    if (!upstream.ok) {
      return new Response(`upstream ${upstream.status}`, { status: 502 });
    }
    const buf = await upstream.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "X-Audio-Seconds": upstream.headers.get("X-Audio-Seconds") ?? "",
        "X-Realtime-Factor": upstream.headers.get("X-Realtime-Factor") ?? "",
      },
    });
  } catch {
    // backend unreachable — signal the client to use its browser-speech fallback
    return new Response("backend unreachable", { status: 503 });
  }
}
