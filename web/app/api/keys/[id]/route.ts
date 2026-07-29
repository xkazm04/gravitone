import { NextRequest } from "next/server";

import { proxyJson } from "@/lib/backend";

// rotate: POST /api/keys/{id}  (delegates to backend /v1/keys/{id}/rotate)
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/keys/${encodeURIComponent(id)}/rotate`, { method: "POST" });
}

// destroy: DELETE /api/keys/{id}  (delegates to backend DELETE /v1/keys/{id})
//
// DESTRUCTIVE and NOT the answer to a leak — it erases the key's audit identity
// along with the key. The non-destructive kill lives at ./revoke/route.ts and is
// what the ledger offers first; this stays reachable because deleting a key you
// created by mistake is legitimate.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Passthrough: a non-2xx carries a `detail` body the ledger UI shows; the old
  // `new Response(null)` dropped it.
  return proxyJson(`/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}
