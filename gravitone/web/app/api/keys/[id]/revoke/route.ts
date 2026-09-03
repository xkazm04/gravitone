import { NextRequest } from "next/server";

import { proxyJson } from "@/lib/backend";
import { identify, modeHeaders, ownedKey } from "../../identity";

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
//
// AUTHORIZED FIRST. Revocation is the most attractive of these calls to an
// attacker who cannot read a key: it needs no secret, only an id, and it kills
// someone else's credential instantly. `ownedKey` refuses an id the caller does
// not own with the same 404 an unknown id gets, so the ledger cannot be probed
// by watching which refusal comes back.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const caller = await identify(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  const key = await ownedKey(id, caller);
  if (key instanceof Response) return key;
  const res = await proxyJson(`/v1/keys/${encodeURIComponent(id)}/revoke`, {
    credential: "operator",
    method: "POST",
  });
  for (const [k, v] of Object.entries(modeHeaders(caller.mode))) res.headers.set(k, v);
  return res;
}
