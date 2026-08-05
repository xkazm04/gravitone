// GET /api/keys/{id}/manifest — the key, as a machine reads it.
//
// A Gravitone key stops being a string you paste into code and becomes a
// self-describing contract: which tools it opens, at which endpoints, with
// which arguments, and what is known about whether this deployment would
// actually serve them. Derived entirely from the shared capability table
// (`app/keys/_variants/capabilities.ts`) plus the key's own scopes — no backend
// change, nothing invented here.
//
// THE BOUNDARY IS THE POINT: a scope the key does not hold contributes no
// tools. Not a disabled entry, not a flag — absent. An agent handed this
// manifest cannot plan around a call this deployment would refuse, because it
// never learns the call exists.
//
// A REVOKED key opens nothing, so its manifest carries an empty toolbox and
// says why. Publishing its capabilities would describe access that no longer
// exists.
//
// `proven` is "unknown" on everything this route emits, and that is not
// laziness: a PROVING attestation lives in the browser that ran the sweep
// (see _variants/attestation.ts), so the server has no proof to read — and it
// deliberately does not accept a caller's assertion of one, because a claim
// about a probe is not a probe. The studio folds its own attestation in
// client-side with `foldProof` before it renders or copies a manifest.

import { NextRequest } from "next/server";

import { jsonError } from "@/lib/backend";
import { AUTH, baseUrl } from "../../deployment";
import { displayName, identify, modeHeaders, ownedKey } from "../../identity";
import {
  capabilitiesFor,
  scopesWithoutCapabilities,
  type KeyManifest,
} from "@/app/keys/_variants/capabilities";

// A manifest describes what ONE credential opens, which is a statement about
// that credential — so it is answerable only to the person who holds it.
// `ownedKey` (../../identity) reads the ledger, finds the id, and refuses one
// the caller does not own with the same 404 an unknown id gets.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const caller = await identify(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  const key = await ownedKey(id, caller);
  if (key instanceof Response) {
    // "no such key" and "not signed in" are answers. Anything else means the
    // ledger could not be READ, and this surface has always said so in one
    // sentence rather than leaking a backend status into a document about a
    // credential — an unreadable ledger is not an empty toolbox.
    return key.status === 404 || key.status === 401
      ? key
      : jsonError("backend unreachable — no manifest can be derived", 503);
  }

  const scopes = Array.isArray(key.scopes) ? key.scopes : [];
  const revoked = key.revoked === true;
  const base = baseUrl();

  const manifest: KeyManifest = {
    manifest_version: 1,
    generated_at: new Date().toISOString(),
    base_url: base.url,
    auth: { ...AUTH },
    // `displayName`: the stored name carries the ownership tag, which is
    // server bookkeeping and not part of anyone's credential.
    key: { id: key.id, name: displayName(key.name), prefix: key.prefix, scopes, revoked },
    // Revoked: the toolbox is empty because the credential is dead, and the
    // `boundary` line below says so in the same breath.
    tools: revoked ? [] : capabilitiesFor(scopes).map((c) => ({ ...c, proven: "unknown" as const })),
    boundary: revoked
      ? "This key is REVOKED: it authenticates nothing, so it opens no tools. Rotate it (or mint a new one) to get a working manifest."
      : `This key holds ${scopes.length} scope(s): ${scopes.join(", ") || "none"}. Every other capability this deployment has is absent from this manifest on purpose — the key's scopes are the agent's boundary.`,
    proof: {
      source: "none",
      note:
        "No capability here has been proved against this deployment. A proof is a probe the studio ran " +
        "while it briefly held the secret, and it is kept in that browser — the server has none to serve " +
        "and will not restate a caller's claim of one as fact.",
    },
    uncovered_scopes: revoked ? [] : scopesWithoutCapabilities(scopes),
  };

  if (base.caveat) {
    // The caveat rides ON the document rather than in a doc page, because the
    // agent reading this is the one that will call the wrong host.
    (manifest as KeyManifest & { base_url_note?: string }).base_url_note = base.caveat;
  }

  return Response.json(manifest, {
    // A manifest is derived from a key that can be rotated or revoked at any
    // moment; a cached one describes access that may already be gone.
    headers: { "Cache-Control": "no-store", ...modeHeaders(caller.mode) },
  });
}
