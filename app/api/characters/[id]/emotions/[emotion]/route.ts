// Remove an empty custom emotion slot (backend 409s while a Voice occupies it).
import { NextRequest } from "next/server";
import { backendFetch } from "@/lib/backend";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; emotion: string }> }) {
  const { id, emotion } = await ctx.params;
  try {
    const r = await backendFetch(
      `/v1/characters/${encodeURIComponent(id)}/emotions/${encodeURIComponent(emotion)}`,
      { method: "DELETE" },
    );
    if (r.status === 204) return new Response(null, { status: 204 });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ detail: "backend unreachable" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
}
