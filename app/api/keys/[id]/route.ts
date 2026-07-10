import { NextRequest } from "next/server";

const BASE = process.env.GRAVITONE_URL ?? "http://127.0.0.1:8080";

// rotate: POST /api/keys/{id}  (delegates to backend /v1/keys/{id}/rotate)
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await fetch(`${BASE}/v1/keys/${encodeURIComponent(id)}/rotate`, { method: "POST" });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await fetch(`${BASE}/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    return new Response(null, { status: r.status });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
