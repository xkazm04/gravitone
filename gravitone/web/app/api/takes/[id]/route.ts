// Shared-take metadata — public (the share page is the point).
import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/takes/${encodeURIComponent(id)}`, { credential: "operator" });
}
