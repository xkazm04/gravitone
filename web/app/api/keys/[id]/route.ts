import { NextRequest } from "next/server";

import { backendFetch } from "@/lib/backend";

// rotate: POST /api/keys/{id}  (delegates to backend /v1/keys/{id}/rotate)
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/keys/${encodeURIComponent(id)}/rotate`, { method: "POST" });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    return new Response(null, { status: r.status });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
