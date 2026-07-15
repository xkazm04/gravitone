// Stem preview audio for one detected emotion — streamed + cached via the
// shared ingest-asset proxy (see lib/backend#streamIngestAsset).
import { NextRequest } from "next/server";
import { streamIngestAsset } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ job: string; emotion: string }> }) {
  const { job, emotion } = await ctx.params;
  return streamIngestAsset(
    `/v1/ingest/${encodeURIComponent(job)}/preview/${encodeURIComponent(emotion)}`,
  );
}
