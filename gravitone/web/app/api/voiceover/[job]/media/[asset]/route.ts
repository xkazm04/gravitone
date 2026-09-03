import { backendFetch, jsonError, READ_TIMEOUT_MS } from "@/lib/backend";

// Stream one finished voiceover artifact. One route, an allowlist of assets —
// the upstream refusal (409 "not finished", 404 expired) passes through as
// JSON exactly like streamIngestAsset's contract.
const ASSETS: Record<string, { path: string; type: string }> = {
  video: { path: "video", type: "video/mp4" },
  track: { path: "track", type: "audio/wav" },
  script: { path: "script", type: "application/json" },
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
      `/v1/voiceover/${encodeURIComponent(job)}/${spec.path}`,
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
