// The client's decision — public (reviewers never sign in).
import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/reviews/${encodeURIComponent(id)}/pick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}
