// Score run B against run A (POST /v1/convai/compare) — pure arithmetic.
//
// Both artifacts travel in the body; the studio holds its own runs in memory
// and never asks the backend to read a file path. The scoring logic stays in
// service/gym.py — re-implementing thresholds client-side is how two verdicts
// drift apart.
import { proxyJson, readCappedText } from "@/lib/backend";

// Two full run artifacts comfortably fit; a long conversation is still text.
const MAX_COMPARE_BODY_BYTES = 512 * 1024;

export async function POST(req: Request) {
  const body = await readCappedText(req, MAX_COMPARE_BODY_BYTES);
  if (body instanceof Response) return body;
  return proxyJson("/v1/convai/compare", {
    credential: "operator",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
