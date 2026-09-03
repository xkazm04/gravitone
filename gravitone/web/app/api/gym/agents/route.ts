// The convai agent roster (GET /v1/convai/agents), proxied for the gym page.
//
// Operator credential: the gym router sits behind require_scope("convai")
// upstream, and the root key is the only credential this process holds. The
// route rations that authority by being read-only — it exposes which agents
// exist and which brain answers, nothing a caller can spend.
import { proxyJson } from "@/lib/backend";

export async function GET() {
  return proxyJson("/v1/convai/agents", { credential: "operator" });
}
