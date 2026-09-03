// One recorded conversation's transcript (GET /v1/convai/conversations/{id}).
//
// Text only — the upstream deliberately does not serve the audio on an id
// guess, and this proxy inherits that posture by construction.
import { NextRequest } from "next/server";

import { proxyJson } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/convai/conversations/${encodeURIComponent(id)}`, {
    credential: "operator",
  });
}
