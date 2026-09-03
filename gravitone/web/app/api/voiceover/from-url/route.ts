import { proxyJson } from "@/lib/backend";

// Kick off a silent-video voiceover from a link. Long timeout: the backend
// probes the link (up to ~25s) before answering with a job id — same shape as
// /api/ingest/scan-url.
export async function POST(req: Request) {
  return proxyJson("/v1/voiceover/from-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
    timeoutMs: 60_000,
    credential: "operator",
  });
}
