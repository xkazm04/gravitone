// Retag / rename / delete a voice, proxied to the Gravitone backend.
import { NextRequest } from "next/server";

const BASE = process.env.GRAVITONE_URL ?? "http://127.0.0.1:8080";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const body = await req.text();
    const r = await fetch(`${BASE}/v1/voices/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await fetch(`${BASE}/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
    return new Response(null, { status: r.status });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
