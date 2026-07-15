// Shared-take audio — public, streamed.
import { NextRequest } from "next/server";
import { backendFetch, READ_TIMEOUT_MS } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/takes/${encodeURIComponent(id)}/audio`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!r.ok) return new Response(await r.text(), { status: r.status });
    return new Response(r.body, {
      status: 200,
      headers: { "Content-Type": "audio/wav", "Cache-Control": "public, max-age=3600" },
    });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
