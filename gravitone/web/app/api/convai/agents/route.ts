import { proxyJson } from "@/lib/backend";

// Which agents this replica can run, which brain answers for them, and how many
// conversation slots are left (`sessions.active` / `sessions.max`).
//
// Thin on purpose: the browser cannot hold the root API key, and it cannot put
// one on a WebSocket handshake either — which is why the signed-url sibling
// route exists. Both keep key attachment server-side (lib/backend).
//
// Status passthrough matters here: `enabled: false` is a 200 with a body, but a
// keyed backend answering 401 must NOT read as "no agents installed".
export async function GET() {
  return proxyJson(`/v1/convai/agents`, { credential: "operator" });
}
