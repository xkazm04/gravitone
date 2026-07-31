import { NextRequest } from "next/server";

import { proxyJson } from "@/lib/backend";

// revoke: POST /api/keys/{id}/revoke  (delegates to backend /v1/keys/{id}/revoke)
//
// This is the studio's answer to a LEAKED key, and it is deliberately a
// different route from DELETE: revoking stops the key authenticating on the
// next request but keeps it in GET /v1/keys with `revoked: true`, so "what was
// this key allowed to do, and when was it last used?" stays answerable. DELETE
// destroys that audit identity — see ../route.ts.
//
// The path mirrors the backend's 1:1 so the two are greppable together. The
// backend is idempotent (revoking a revoked key succeeds unchanged) and 404s an
// unknown id; proxyJson passes both statuses and their `detail` through.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/keys/${encodeURIComponent(id)}/revoke`, { method: "POST" });
}
