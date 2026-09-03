// Recorded conversations (GET /v1/convai/conversations), proxied for the gym.
//
// The upstream answer carries `recording: false` when CONVAI_RECORD is off —
// the gym page reads that flag to say WHY the list is empty instead of showing
// a false "no conversations yet" state.
import { proxyJson } from "@/lib/backend";

export async function GET() {
  return proxyJson("/v1/convai/conversations", { credential: "operator" });
}
