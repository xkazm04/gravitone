// WHO is asking, and WHICH keys are theirs. Server-only.
//
// The key ledger is the one studio surface where the proxy's operator
// credential is genuinely dangerous: `/v1/keys` is mounted behind
// `require_scope("admin")`, the root key satisfies it, and the proxy presented
// that key on every request while performing no authorization of its own. An
// anonymous POST to /api/keys minted a working backend credential; a GET
// enumerated everyone's; POST /api/keys/{id}/revoke killed anyone's. The
// service's admin check was not bypassed — it was answered, correctly, on
// behalf of a stranger.
//
// ── The posture, in two modes ────────────────────────────────────────────────
//
// SINGLE-USER (Firebase not configured). The default `git clone && npm run dev`
// deployment, and the one this project exists for: your own box, your own
// voices, no accounts. Every caller is the same person, so identity is a
// constant (`local`) and no token is required. This is not a hole being left
// open — it is the honest description of a one-person deployment, where the
// studio ALSO proxies unauthenticated voice cloning, deletion and synthesis to
// the same backend. Gating key minting alone would buy nothing. What the
// studio owes such an operator instead is that the door is NAMED: every key
// response carries `X-Gravitone-Auth-Mode: single-user`, and .env.example says
// what turns it into the other mode.
//
// FIREBASE (a project id is configured — the deployed studio). Now there are
// several people behind one process, and "my keys" has to mean something. Every
// key call requires a Firebase ID token verified SERVER-side (lib/idToken.ts),
// and every key operation is scoped to the verified uid.
//
// ── Where ownership lives ────────────────────────────────────────────────────
//
// The backend key store has no owner column and adding one is a service change.
// It does have a `name`, which the studio controls end to end, so ownership is
// carried as a tag on the name: `u:<uid>|<the name the user typed>`. The tag is
// applied on create and stripped on the way out, so the ledger looks exactly as
// it did. A caller cannot forge one: the uid comes from a verified token and
// the tag is written by this module, never read from the request body.
//
// LEGACY KEYS (created before this, with no tag) belong to nobody. In
// single-user mode that is the local operator, so an existing install keeps its
// keys. In Firebase mode they are neither listed nor mutable through the studio
// — the safe direction, and they remain fully manageable by an operator holding
// the root key directly against the service.

import { backendFetch, jsonError, READ_TIMEOUT_MS } from "@/lib/backend";
import { firebaseProjectId, UID_SHAPE, verifyIdToken } from "@/lib/idToken";

export type AuthMode = "firebase" | "single-user";

/** The uid every caller shares when there are no accounts. */
export const LOCAL_UID = "local";

export function authMode(): AuthMode {
  return firebaseProjectId() ? "firebase" : "single-user";
}

export type Caller = { uid: string; mode: AuthMode };

/** The header every key response carries, so the deployment's posture is
 *  readable from a response rather than inferred from a config file. */
export function modeHeaders(mode: AuthMode): Record<string, string> {
  return { "X-Gravitone-Auth-Mode": mode };
}

const UNAUTHORIZED =
  "sign in to manage API keys — send your Firebase ID token as " +
  "Authorization: Bearer <token>";

/** Identify the caller, or return the Response to send them.
 *
 *  In Firebase mode the ONLY accepted credential is a Firebase ID token in
 *  `Authorization: Bearer`. Notably NOT accepted: a Gravitone API key. A
 *  managed key can never hold `admin` upstream, and letting one manage the
 *  ledger here would hand the proxy's root authority to a credential the
 *  service itself refuses for this surface. */
export async function identify(req: Request): Promise<Caller | Response> {
  const mode = authMode();
  if (mode === "single-user") return { uid: LOCAL_UID, mode };

  const auth = req.headers.get("authorization") ?? "";
  const token = /^bearer\s+(.+)$/i.exec(auth.trim())?.[1]?.trim() ?? "";
  if (!token) return unauthorized(mode);
  const verified = await verifyIdToken(token);
  if (!verified || !UID_SHAPE.test(verified.uid)) return unauthorized(mode);
  return { uid: verified.uid, mode };
}

function unauthorized(mode: AuthMode): Response {
  return new Response(JSON.stringify({ detail: UNAUTHORIZED }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      // A 401 without a challenge is a 401 a client cannot act on.
      "WWW-Authenticate": 'Bearer realm="gravitone-keys"',
      ...modeHeaders(mode),
    },
  });
}

// ── ownership tag ───────────────────────────────────────────────────────────

const TAG_SEP = "|";

/** `u:<uid>|<name>` — the stored name for a key owned by `uid`. */
export function tagName(uid: string, name: string): string {
  return `u:${uid}${TAG_SEP}${name}`;
}

/** The uid a stored name is tagged with, or null for an untagged (legacy) key.
 *  Splits on the FIRST separator only, so a name containing `|` — or one a user
 *  crafted to look like a tag — cannot change the owner it parses to. */
export function ownerOf(storedName: unknown): string | null {
  if (typeof storedName !== "string" || !storedName.startsWith("u:")) return null;
  const sep = storedName.indexOf(TAG_SEP);
  if (sep < 0) return null;
  const uid = storedName.slice(2, sep);
  return UID_SHAPE.test(uid) ? uid : null;
}

/** The name to SHOW: the tag is bookkeeping, never something a user typed. */
export function displayName(storedName: unknown): string {
  if (typeof storedName !== "string") return "";
  const owner = ownerOf(storedName);
  return owner === null ? storedName : storedName.slice(`u:${owner}${TAG_SEP}`.length);
}

/** May `caller` see and act on a key with this stored name?
 *
 *  Untagged keys predate ownership: the lone local operator owns them; in a
 *  multi-user deployment nobody does. */
export function ownedBy(storedName: unknown, caller: Caller): boolean {
  const owner = ownerOf(storedName);
  if (owner === null) return caller.mode === "single-user";
  return owner === caller.uid;
}

// ── the ledger, read once and shared ────────────────────────────────────────

export type LedgerKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created?: string;
  last_used?: string | null;
  revoked?: boolean;
};

/** GET /v1/keys, parsed. The service has no "one key" read and no per-owner
 *  query, so every ownership decision is made against this list. */
export async function readLedger(): Promise<LedgerKey[] | Response> {
  let r: Response;
  try {
    r = await backendFetch("/v1/keys", {
      credential: "operator",
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
  if (!r.ok) {
    const headers = new Headers({ "Content-Type": "application/json" });
    const retryAfter = r.headers.get("Retry-After");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    return new Response(await r.text(), { status: r.status, headers });
  }
  try {
    const list = (await r.json()) as unknown;
    if (!Array.isArray(list)) return jsonError("the key ledger could not be read", 502);
    return list as LedgerKey[];
  } catch {
    return jsonError("the key ledger could not be read", 502);
  }
}

/** 404, not 403, for a key the caller does not own.
 *
 *  Deliberate: a 403 confirms the id exists, which is the enumeration this
 *  whole module removes. Someone else's key is indistinguishable from no key —
 *  and, to this caller, it may as well be. */
export function notFound(mode: AuthMode): Response {
  return new Response(JSON.stringify({ detail: "no such key" }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...modeHeaders(mode) },
  });
}

/** Resolve `id` to a key this caller owns, or the Response to send instead. */
export async function ownedKey(id: string, caller: Caller): Promise<LedgerKey | Response> {
  const ledger = await readLedger();
  if (ledger instanceof Response) return ledger;
  const key = ledger.find((k) => k?.id === id);
  if (!key || !ownedBy(key.name, caller)) return notFound(caller.mode);
  return key;
}

/** The public shape of a key: the ownership tag never leaves the server. */
export function publicKey<T extends { name?: unknown }>(key: T): T {
  return { ...key, name: displayName(key.name) };
}
