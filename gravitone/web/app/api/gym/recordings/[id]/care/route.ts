// The operator's per-turn care marks on one recorded conversation.
// GET reads them; PUT replaces the whole document (the studio holds the full
// list while the operator listens — see recording.save_care for why there is
// no merge contract).
import { NextRequest } from "next/server";

import { proxyJson, readCappedText } from "@/lib/backend";

const MAX_CARE_BODY_BYTES = 64 * 1024;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/convai/conversations/${encodeURIComponent(id)}/care`, {
    credential: "operator",
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readCappedText(req, MAX_CARE_BODY_BYTES);
  if (body instanceof Response) return body;
  return proxyJson(`/v1/convai/conversations/${encodeURIComponent(id)}/care`, {
    credential: "operator",
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
