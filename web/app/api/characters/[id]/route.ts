import { NextRequest } from "next/server";

import { backendFetch, jsonError } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/characters/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!r.ok) return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
    return new Response(await r.text(), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch {
    return jsonError("backend unreachable", 503);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/characters/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/characters/${encodeURIComponent(id)}`, { method: "DELETE" });
    return new Response(null, { status: r.status });
  } catch {
    return jsonError("backend unreachable", 503);
  }
}
