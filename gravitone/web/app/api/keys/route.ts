// The key ledger: list what you own, mint another.
//
// This file used to be twelve lines with no authorization at all, proxying
// straight through with the backend's ROOT key attached — so an anonymous
// `POST /api/keys` minted a working credential for the deployment and a `GET`
// enumerated everybody's. Both now go through `identify` first, and every row
// is scoped to the caller. See ./identity.ts for the two auth modes and for why
// ownership is carried on the key's name.

import { backendFetch, jsonError, WRITE_TIMEOUT_MS } from "@/lib/backend";
import {
  identify,
  modeHeaders,
  ownedBy,
  publicKey,
  readLedger,
  tagName,
  type Caller,
} from "./identity";

/** The scopes the service will grant a managed key (service/keys.py::SCOPES).
 *  Checked HERE too — not because the service would grant `admin` (it refuses),
 *  but because this route asks with the root key, so what it forwards is what
 *  it is willing to have granted in its own name. */
const GRANTABLE = new Set(["tts", "voices", "clone", "performance", "stt", "convai"]);

const MAX_NAME = 120;

export async function GET(req: Request): Promise<Response> {
  const caller = await identify(req);
  if (caller instanceof Response) return caller;

  const ledger = await readLedger();
  if (ledger instanceof Response) return ledger;

  return Response.json(
    ledger.filter((k) => ownedBy(k?.name, caller)).map(publicKey),
    { headers: { "Cache-Control": "no-store", ...modeHeaders(caller.mode) } },
  );
}

export async function POST(req: Request): Promise<Response> {
  const caller = await identify(req);
  if (caller instanceof Response) return caller;

  let body: { name?: unknown; scopes?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError("body must be JSON", 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return jsonError("a key needs a name", 400);
  if (name.length > MAX_NAME) return jsonError(`a key name is at most ${MAX_NAME} characters`, 400);

  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s): s is string => typeof s === "string")
    : [];
  if (!scopes.length) return jsonError("a key needs at least one scope", 400);
  const ungrantable = scopes.filter((s) => !GRANTABLE.has(s));
  if (ungrantable.length) {
    return jsonError(`scope '${ungrantable[0]}' is not grantable to a managed key`, 400);
  }

  // The name goes upstream TAGGED with the verified uid — the only place a key
  // acquires an owner, and the reason a later revoke can be refused.
  return mint("/v1/keys", { name: tagName(caller.uid, name), scopes }, caller);
}

/** POST a key-minting call and return the created/rotated key with its stored
 *  name translated back to the one the user typed. Shared with the rotate
 *  route, which returns the same shape. */
export async function mint(
  path: string,
  payload: unknown,
  caller: Caller,
): Promise<Response> {
  let r: Response;
  try {
    r = await backendFetch(path, {
      credential: "operator",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
  const headers = new Headers({ "Content-Type": "application/json", ...modeHeaders(caller.mode) });
  const retryAfter = r.headers.get("Retry-After");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  const text = await r.text();
  if (!r.ok) return new Response(text, { status: r.status, headers });
  try {
    return new Response(JSON.stringify(publicKey(JSON.parse(text) as { name?: unknown })), {
      status: r.status,
      headers,
    });
  } catch {
    // A 2xx we could not parse is still the backend's answer; passing it
    // through beats inventing an error for a key that WAS created.
    return new Response(text, { status: r.status, headers });
  }
}
