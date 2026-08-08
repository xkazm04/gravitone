import { backendFetch, jsonError, READ_TIMEOUT_MS } from "@/lib/backend";

// One scene's representative frame (jpeg). Cached hard: a scene's frame is
// written once during the job and never changes.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ job: string; i: string }> },
) {
  const { job, i } = await ctx.params;
  const n = Number.parseInt(i, 10);
  if (!Number.isFinite(n) || n < 0) return jsonError("bad scene index", 400);
  try {
    const r = await backendFetch(
      `/v1/voiceover/${encodeURIComponent(job)}/frame/${n}`,
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
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600, immutable" },
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
}
