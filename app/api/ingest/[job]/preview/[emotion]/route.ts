import { NextRequest } from "next/server";
import { backendFetch } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ job: string; emotion: string }> }) {
  const { job, emotion } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/ingest/${encodeURIComponent(job)}/preview/${encodeURIComponent(emotion)}`);
    if (!r.ok) return new Response("not found", { status: r.status });
    return new Response(await r.arrayBuffer(), { status: 200, headers: { "Content-Type": "audio/wav" } });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
