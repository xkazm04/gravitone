import { NextRequest } from "next/server";

import { proxyJson } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/characters/${encodeURIComponent(id)}`, { credential: "operator" });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/characters/${encodeURIComponent(id)}`, {
    credential: "operator",
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Passthrough (not `new Response(null)`): a backend 409/404 carries a detail
  // body the client surfaces; only true 204s stay bodyless.
  return proxyJson(`/v1/characters/${encodeURIComponent(id)}`, { credential: "operator", method: "DELETE" });
}
