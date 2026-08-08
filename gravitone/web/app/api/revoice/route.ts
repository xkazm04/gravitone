import { proxyJson } from "@/lib/backend";

// Kick off a re-voice: the source link plus the studio's (possibly edited)
// scene lines. Long timeout — the backend probes the link before answering.
export async function POST(req: Request) {
  return proxyJson("/v1/revoice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
    timeoutMs: 60_000,
    credential: "operator",
  });
}
