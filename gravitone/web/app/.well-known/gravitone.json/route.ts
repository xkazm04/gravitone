// GET /.well-known/gravitone.json — the DEPLOYMENT half of the handshake.
//
// The per-key manifest says what one credential opens. This says what the box
// is: where to send requests, which header carries the key, which audio formats
// the format grammar accepts, and the one thing that surprises every new client
// — CORS is closed by default, so a browser cannot call this deployment at all
// until an operator names its origin. A client that has only a key and a host
// can bootstrap from these two documents and nothing else.
//
// Deliberately NOT here: whether key enforcement is on. That is measurable only
// by sending an unauthenticated request (app/api/keys/probe does exactly that),
// and a static document that guessed would be guessing about the one thing
// worth being sure of. The auth block says so instead.
//
// Also deliberately not here: a live engine list. Engines are the service's to
// declare (/v1/models, /v1/voices, and the engine plane's own surface); this
// document points at them rather than mirroring a list that would go stale.

import { AUTH, baseUrl } from "@/app/api/keys/deployment";
import { AUDIO_FORMATS, CAPABILITIES, SCOPES } from "@/app/keys/_variants/capabilities";

export async function GET(): Promise<Response> {
  const base = baseUrl();
  const doc = {
    gravitone: 1,
    generated_at: new Date().toISOString(),
    base_url: base.url,
    base_url_source: base.source,
    ...(base.caveat ? { base_url_note: base.caveat } : {}),
    elevenlabs_compatible: true,
    auth: { ...AUTH },
    formats: {
      ...AUDIO_FORMATS,
      note:
        "Passed as ?output_format=. An unsupported kind, rate or bitrate is a 400 that lists what IS " +
        "supported — never a silent fallback to a rate you did not ask for.",
    },
    cors: {
      browser_calls: "blocked by default",
      why:
        "TTS_CORS_ORIGINS is empty on a default deployment, so a browser's preflight fails before the key " +
        "is ever sent. The failure looks like a broken deployment and is actually the policy.",
      enable: "Set TTS_CORS_ORIGINS to your origin on the service and restart.",
      recommended:
        "Call from a server (Node, an edge function, your own API) — that path needs no CORS and is what " +
        "the migration snippets and the MCP bridge use.",
    },
    discovery: {
      voices: "/v1/voices",
      models: "/v1/models",
      health: "/health",
      key_manifest: "/api/keys/{key_id}/manifest",
      mcp_bridge: "agents/mcp-gravitone (in this repository)",
    },
    scopes: SCOPES.map((s) => ({ id: s.id, label: s.label, hint: s.hint })),
    // The full table, unscoped: what the DEPLOYMENT can do. Which of these a
    // given credential opens is the per-key manifest's answer, never this one's.
    capabilities: CAPABILITIES.map((c) => ({
      id: c.id,
      scope: c.scope,
      method: c.method,
      endpoint: c.endpoint,
      summary: c.summary,
    })),
    capability_note:
      "Listing a capability says this deployment SERVES it, not that your key may call it. Fetch the " +
      "per-key manifest for the boundary that applies to a credential.",
  };

  return Response.json(doc, {
    headers: {
      // Short and public: a deployment document changes when an operator
      // reconfigures the box, and a stale one sends agents to the wrong host.
      "Cache-Control": "public, max-age=300",
    },
  });
}
