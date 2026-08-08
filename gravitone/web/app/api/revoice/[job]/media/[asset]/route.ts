import { backendFetch, jsonError, READ_TIMEOUT_MS } from "@/lib/backend";

const ASSETS: Record<string, { path: string; type: string }> = {
  video: { path: "video", type: "video/mp4" },
  track: { path: "track", type: "audio/wav" },
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ job: string; asset: string }> },
) {
  const { job, asset } = await ctx.params;
  const spec = ASSETS[asset];
  if (!spec) return jsonError("unknown asset", 404);
  try {
    const r = await backendFetch(
      `/v1/revoice/${encodeURIComponent(job)}/${spec.path}`,
      { credential: "operator", signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
    );
    if (!r.ok) {
      const body = await r.text();
      return body
        ? new Response(body, { status: r.status, headers: { "Content-Type": "application/json" } })
        : jsonError("not found", r.status);
    }
    return new Response(r.body, {
      status: 200,
      headers: { "Content-Type": spec.type, "Cache-Control": "private, max-age=300" },
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
}
