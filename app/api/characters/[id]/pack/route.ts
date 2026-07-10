// Download a Character Pack (.gravichar) — streamed from the backend.
import { NextRequest } from "next/server";
import { backendFetch } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/characters/${encodeURIComponent(id)}/pack`);
    if (!r.ok) return new Response(await r.text(), { status: r.status });
    return new Response(r.body, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": r.headers.get("Content-Disposition") ?? `attachment; filename="${id}.gravichar"`,
        "X-Pack-Voices": r.headers.get("X-Pack-Voices") ?? "",
      },
    });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
