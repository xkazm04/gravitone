import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  // The poller — hit every 1-5s during a job. proxyJson gives it the read
  // timeout it never had (a hung backend used to pin this handler open).
  const { job } = await ctx.params;
  return proxyJson(`/v1/ingest/${encodeURIComponent(job)}`);
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  return proxyJson(`/v1/ingest/${encodeURIComponent(job)}`, { method: "DELETE" });
}
