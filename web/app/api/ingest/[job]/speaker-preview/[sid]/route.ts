import { NextRequest } from "next/server";
import { backendFetch } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ job: string; sid: string }> }) {
  const { job, sid } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/ingest/${encodeURIComponent(job)}/speaker-preview/${encodeURIComponent(sid)}`);
    if (!r.ok) return new Response("not found", { status: r.status });
    // Stream the upstream body (no full buffer) and cache: a job's preview wav
    // is written once and never changes, so replays serve from the browser.
    return new Response(r.body, { status: 200, headers: {
      "Content-Type": "audio/wav",
      "Cache-Control": "private, max-age=3600, immutable",
    } });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
