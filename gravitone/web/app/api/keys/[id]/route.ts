import { NextRequest } from "next/server";

import { proxyJson } from "@/lib/backend";
import { identify, modeHeaders, ownedKey } from "../identity";
import { mint } from "../route";

// rotate: POST /api/keys/{id}  (delegates to backend /v1/keys/{id}/rotate)
//
// Ownership is checked BEFORE the id reaches the backend: rotating someone
// else's key invalidates their credential and hands the replacement to whoever
// asked. `ownedKey` answers 404 for a key that exists but is not the caller's —
// see ../identity.ts for why not 403.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const caller = await identify(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  const key = await ownedKey(id, caller);
  if (key instanceof Response) return key;
  // `mint`, because rotate answers with a key AND its secret AND its stored
  // name — the ownership tag must be translated off it exactly as on create.
  return mint(`/v1/keys/${encodeURIComponent(id)}/rotate`, undefined, caller);
}

// destroy: DELETE /api/keys/{id}  (delegates to backend DELETE /v1/keys/{id})
//
// DESTRUCTIVE and NOT the answer to a leak — it erases the key's audit identity
// along with the key. The non-destructive kill lives at ./revoke/route.ts and is
// what the ledger offers first; this stays reachable because deleting a key you
// created by mistake is legitimate.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const caller = await identify(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  const key = await ownedKey(id, caller);
  if (key instanceof Response) return key;
  // Passthrough: a non-2xx carries a `detail` body the ledger UI shows; the old
  // `new Response(null)` dropped it.
  const res = await proxyJson(`/v1/keys/${encodeURIComponent(id)}`, {
    credential: "operator",
    method: "DELETE",
  });
  for (const [k, v] of Object.entries(modeHeaders(caller.mode))) res.headers.set(k, v);
  return res;
}
