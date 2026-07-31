import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function POST(req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  return proxyJson(`/v1/ingest/${encodeURIComponent(job)}/speaker`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}
