// Replay a recorded conversation (POST /v1/convai/replay).
//
// A replay is a whole conversation of blocking work — decode, transcribe,
// synthesize, per turn — bounded upstream by DEADLINE_S (180 s). The timeout
// here sits above that ceiling so the proxy never gives up on a replay the
// backend is still honestly running; the 409 (gym busy), 503 (convai disabled)
// and 404 (unknown recording) refusals pass through with their upstream
// sentences intact, because each one tells the user a different true thing.
import { proxyJson, readCappedText } from "@/lib/backend";

export async function POST(req: Request) {
  const body = await readCappedText(req);
  if (body instanceof Response) return body;
  return proxyJson("/v1/convai/replay", {
    credential: "operator",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeoutMs: 200_000,
  });
}
