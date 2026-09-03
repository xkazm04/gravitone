// One labelled segment's own audio — the atom a stem is spliced from. Streamed
// + cached through the shared ingest-asset proxy, exactly like the speaker
// sample and the stem preview it sits beside: a segment wav is immutable for
// the life of the job, so it is worth caching, and it is never JSON.
import { NextRequest } from "next/server";
import { streamIngestAsset } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ job: string; index: string }> }) {
  const { job, index } = await ctx.params;
  return streamIngestAsset(
    `/v1/ingest/${encodeURIComponent(job)}/segment/${encodeURIComponent(index)}`, { credential: "operator" },
  );
}
