import { NextRequest } from "next/server";

import { proxyJson } from "@/lib/backend";

// rotate: POST /api/keys/{id}  (delegates to backend /v1/keys/{id}/rotate)
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/keys/${encodeURIComponent(id)}/rotate`, { method: "POST" });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Passthrough: a 409 ("cannot rotate a revoked key" family) carries a detail
  // body the ledger UI shows; the old `new Response(null)` dropped it.
  return proxyJson(`/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}
