// Metatag-aware speech: one Character, Voices switched per emotion, baseline
// fallback. Forwards the per-segment report so the UI can show substitutions.
import { NextRequest } from "next/server";

import { backendFetch } from "@/lib/backend";

export async function POST(req: NextRequest) {
  try {
    const upstream = await backendFetch(`/v1/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
      signal: AbortSignal.timeout(180_000),
    });
    if (!upstream.ok) {
      return new Response(await upstream.text(), { status: upstream.status });
    }
    return new Response(await upstream.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "X-Audio-Seconds": upstream.headers.get("X-Audio-Seconds") ?? "",
        "X-Realtime-Factor": upstream.headers.get("X-Realtime-Factor") ?? "",
        "X-Segments": upstream.headers.get("X-Segments") ?? "",
      },
    });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
