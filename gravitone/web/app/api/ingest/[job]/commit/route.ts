import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function POST(req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  // Commit returns immediately (cloning runs as a background phase the poller
  // follows); the default write timeout covers the kickoff request.
  return proxyJson(`/v1/ingest/${encodeURIComponent(job)}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}
