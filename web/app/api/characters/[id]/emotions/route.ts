// Mint a custom emotion slot on one Character.
import { NextRequest } from "next/server";
import { backendFetch } from "@/lib/backend";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/characters/${encodeURIComponent(id)}/emotions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
    });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ detail: "backend unreachable" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
}
