import { jsonError, proxyJson } from "@/lib/backend";

// Mint the ticketed WebSocket URL for one conversation.
//
// This is the one call an ElevenLabs integration repoints, and the reason a
// browser can talk to a key-protected service at all: the API key is attached
// HERE (server-side, lib/backend) and the socket that comes back carries a
// short-lived HMAC ticket instead (service/convai.py::mint_ticket).
//
// The returned `signed_url` names the SERVICE origin, not this studio — the
// browser dials the service directly. In a deployment where only the studio is
// exposed, the service must set CONVAI_PUBLIC_URL (or a WS relay is needed);
// the Live stage says so by name when the socket will not open.
export async function GET(req: Request) {
  const agentId = new URL(req.url).searchParams.get("agent_id");
  // Refused here rather than forwarded: the service answers 422 for a missing
  // query parameter, and a validation dump is not a sentence anyone can act on.
  if (!agentId) return jsonError("agent_id is required to open a conversation", 400);
  return proxyJson(
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`, { credential: "operator" },
  );
}
