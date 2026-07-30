// A CHECKED SNAPSHOT of the routes `service/` actually mounts, and the scope
// each one is guarded by. It exists for exactly one reason: a capability
// manifest that names an endpoint the service does not serve is worse than no
// manifest at all — an agent plans around a tool that 404s.
//
// ── UPDATING THIS FILE ───────────────────────────────────────────────────────
// DELIBERATELY, never silently. When the service gains, moves or re-guards a
// route, re-derive the list:
//
//     grep -rn "@app\.\|@router\.\|include_router" service/*.py
//
// reading the router prefixes from each `APIRouter(prefix=...)` and the scope
// from the `dependencies=[Depends(require_scope(...))]` on the route or on its
// `include_router` line. `require_read_write(read, write)` means GET/HEAD/
// OPTIONS need `read` and every other method needs `write` — both are recorded
// below as the scope of the concrete method.
//
// Then run `npx vitest run app/keys/_variants/capabilities.test.ts`. That test
// asserts every capability the manifest can name appears here with the SAME
// method and the SAME scope, and it fails with instructions rather than letting
// the drift ship.
//
// This is a snapshot of a Python service that this TypeScript cannot import.
// It is not, and does not pretend to be, a live check: it converts "the
// manifest quietly drifted" into "a test failed and told you what to fix".
//
// Derived from service/ at the 2026-07-30 Batch-4 snapshot.

export type ServiceRoute = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Full mounted path, router prefix included, `{param}` placeholders intact. */
  path: string;
  /** The key scope required, or `null` for an unauthenticated surface. */
  scope: string | null;
};

export const SERVICE_ROUTES: readonly ServiceRoute[] = [
  // synthesis (service/app.py)
  { method: "POST", path: "/v1/text-to-speech/{voice_id}", scope: "tts" },
  { method: "POST", path: "/v1/text-to-speech/{voice_id}/with-timestamps", scope: "tts" },
  { method: "POST", path: "/v1/text-to-speech/{voice_id}/stream", scope: "tts" },
  { method: "POST", path: "/v1/speak", scope: "tts" },
  { method: "POST", path: "/v1/performance", scope: "performance" },

  // voices + characters (service/voices.py, mounted with require_read_write("tts", "voices"))
  { method: "GET", path: "/v1/voices", scope: "tts" },
  { method: "GET", path: "/v1/voices/{voice_id}", scope: "tts" },
  { method: "POST", path: "/v1/voices", scope: "voices" },
  { method: "PATCH", path: "/v1/voices/{voice_id}", scope: "voices" },
  { method: "DELETE", path: "/v1/voices/{voice_id}", scope: "voices" },
  { method: "GET", path: "/v1/models", scope: "tts" },
  { method: "GET", path: "/v1/emotions", scope: "tts" },
  { method: "GET", path: "/v1/characters", scope: "tts" },
  { method: "GET", path: "/v1/characters/{character_id}", scope: "tts" },
  { method: "GET", path: "/v1/characters/{character_id}/manifest", scope: "tts" },
  { method: "PATCH", path: "/v1/characters/{character_id}", scope: "voices" },
  { method: "DELETE", path: "/v1/characters/{character_id}", scope: "voices" },
  { method: "POST", path: "/v1/characters/{character_id}/emotions", scope: "voices" },
  { method: "DELETE", path: "/v1/characters/{character_id}/emotions/{emotion}", scope: "voices" },

  // packs (service/packs.py, mounted with require_scope("voices"))
  { method: "GET", path: "/v1/characters/{character_id}/pack", scope: "voices" },
  { method: "POST", path: "/v1/characters/import", scope: "voices" },

  // speech-to-text (service/stt.py, mounted with require_scope("stt"))
  { method: "POST", path: "/v1/speech-to-text", scope: "stt" },

  // ingest / cloning (service/ingest_api.py, prefix /v1/ingest, require_scope("clone"))
  { method: "GET", path: "/v1/ingest/modes", scope: "clone" },
  { method: "POST", path: "/v1/ingest/scan", scope: "clone" },
  { method: "GET", path: "/v1/ingest/{job_id}", scope: "clone" },
  { method: "POST", path: "/v1/ingest/{job_id}/speaker", scope: "clone" },
  { method: "POST", path: "/v1/ingest/{job_id}/audition", scope: "clone" },
  { method: "POST", path: "/v1/ingest/{job_id}/commit", scope: "clone" },
  { method: "DELETE", path: "/v1/ingest/{job_id}", scope: "clone" },

  // takes + reviews (service/takes.py, require_scope("tts"))
  { method: "POST", path: "/v1/takes", scope: "tts" },
  { method: "GET", path: "/v1/takes/{take_id}", scope: "tts" },
  { method: "GET", path: "/v1/takes/{take_id}/audio", scope: "tts" },

  // conversation (service/convai.py + service/gym.py, require_scope("convai"))
  { method: "GET", path: "/v1/convai/agents", scope: "convai" },
  { method: "GET", path: "/v1/convai/conversations", scope: "convai" },
  { method: "GET", path: "/v1/convai/conversations/{conversation_id}", scope: "convai" },
  { method: "GET", path: "/v1/convai/conversation/get-signed-url", scope: "convai" },
  { method: "POST", path: "/v1/convai/replay", scope: "convai" },

  // key management — root key ONLY. A managed key is never valid for admin,
  // which is why no capability may ever name one of these.
  { method: "GET", path: "/v1/keys", scope: "admin" },
  { method: "POST", path: "/v1/keys", scope: "admin" },
  { method: "GET", path: "/v1/keys/scopes", scope: "admin" },
  { method: "POST", path: "/v1/keys/{kid}/rotate", scope: "admin" },
  { method: "POST", path: "/v1/keys/{kid}/revoke", scope: "admin" },
  { method: "DELETE", path: "/v1/keys/{kid}", scope: "admin" },
  { method: "GET", path: "/v1/appliance", scope: "admin" },

  // unauthenticated liveness (the privileged detail inside it is scope-gated)
  { method: "GET", path: "/health", scope: null },
] as const;

/** Scopes a managed key can never hold, so no capability may name their routes. */
export const UNGRANTABLE_SCOPES = ["admin"] as const;

export function findRoute(method: string, path: string): ServiceRoute | undefined {
  return SERVICE_ROUTES.find((r) => r.method === method && r.path === path);
}
