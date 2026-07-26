// Download a Character Pack (.gravichar) — streamed from the backend.
import { NextRequest } from "next/server";
import { backendFetch, jsonError, READ_TIMEOUT_MS } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await backendFetch(`/v1/characters/${encodeURIComponent(id)}/pack`, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!r.ok) {
      // Backend errors are JSON {detail}; forward with the right content type.
      return new Response(await r.text(), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(r.body, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": r.headers.get("Content-Disposition") ?? `attachment; filename="${id}.gravichar"`,
        "X-Pack-Voices": r.headers.get("X-Pack-Voices") ?? "",
      },
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
}
