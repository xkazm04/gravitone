// Shared-take metadata — public (the share page is the point).
import { NextRequest } from "next/server";
import { backendFetch, READ_TIMEOUT_MS } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/takes/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
