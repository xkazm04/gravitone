import { NextRequest } from "next/server";
const BASE = process.env.GRAVITONE_URL ?? "http://127.0.0.1:8080";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ job: string; sid: string }> }) {
  const { job, sid } = await ctx.params;
  try {
    const r = await fetch(`${BASE}/v1/ingest/${encodeURIComponent(job)}/speaker-preview/${encodeURIComponent(sid)}`);
    if (!r.ok) return new Response("not found", { status: r.status });
    return new Response(await r.arrayBuffer(), { status: 200, headers: { "Content-Type": "audio/wav" } });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
