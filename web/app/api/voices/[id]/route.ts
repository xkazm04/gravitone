// Retag / rename / delete a voice, proxied to the Gravitone backend.
import { NextRequest } from "next/server";

import { proxyJson } from "@/lib/backend";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/voices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
}
