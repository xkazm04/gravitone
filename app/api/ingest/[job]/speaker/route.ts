import { NextRequest } from "next/server";
import { backendFetch } from "@/lib/backend";

export async function POST(req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/ingest/${encodeURIComponent(job)}/speaker`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: await req.text(),
    });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
