// ── The studio listens back ──────────────────────────────────────────────────
//
// One POST that takes a sentence from a signed-in user and files it in
// Firestore (`feedback/{autoId}`). Deliberately the smallest possible intake:
// no vendor, no dependency, no new credential.
//
// WHY THIS ROUTE VERIFIES ITS OWN CALLER RATHER THAN COPYING A PATTERN
// --------------------------------------------------------------------
// Every other route under app/api/ is a PROXY to the Python backend
// (lib/backend#proxyJson), authenticated with the studio's own root key — none
// of them establishes a *user* identity, and the app carries no firebase-admin
// (see package.json). All user-scoped data in this app is written from the
// CLIENT with the Firebase web SDK, governed by the deployed Firestore rules
// (lib/voiceVault.ts, lib/useAuth.tsx). So there was no server-side session
// pattern to follow.
//
// What it does instead, without adding anything to the dependency tree:
//
//  1. The client sends its Firebase ID TOKEN. It never sends a uid, and this
//     route has no field that would accept one — a caller cannot claim to be
//     someone else, because there is nowhere to put the claim.
//  2. The token is exchanged for an identity at Google's Identity Toolkit
//     (`accounts:lookup`), using the same public web API key lib/firebase.ts
//     already ships. Google decides who the caller is; a forged or expired
//     token is refused there, not here.
//  3. The write goes through the Firestore REST API carrying the USER'S OWN
//     token, so the deployed security rules apply to it exactly as they apply
//     to every client-side write in this app. This route holds no privileged
//     Firestore credential, which means it cannot be turned into one.
//
// A self-hoster with no Firebase project configured gets an honest 503 and a
// studio that never shows the affordance — nothing here is load-bearing for
// the product.

import { jsonError, readCappedText } from "@/lib/backend";
import { MAX_MESSAGE_CHARS, MAX_ROUTE_CHARS, type FeedbackAccepted } from "./limits";

/** Whole-body cap: the message cap plus room for a token and the route. */
const MAX_BODY_BYTES = 16 * 1024;

const LOOKUP_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 10_000;

type Identity = { uid: string; email: string | null };

/** The Firebase project this deployment writes to, or null when the app is
 *  running without Firebase at all (the self-host case). */
function firebaseServerConfig(): { apiKey: string; projectId: string } | null {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  return { apiKey, projectId };
}

/** Ask Google who this token belongs to. Returns null for anything it will not
 *  vouch for — expired, revoked, forged, or issued by another project. */
async function identityFor(idToken: string, apiKey: string): Promise<Identity | null> {
  let r: Response;
  try {
    r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
        cache: "no-store",
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const body = (await r.json().catch(() => null)) as { users?: { localId?: unknown; email?: unknown }[] } | null;
  const u = body?.users?.[0];
  if (!u || typeof u.localId !== "string" || !u.localId) return null;
  return { uid: u.localId, email: typeof u.email === "string" ? u.email : null };
}

/** Firestore REST `Value` shapes for the five fields we store. */
function documentFor(identity: Identity, message: string, route: string) {
  return {
    fields: {
      uid: { stringValue: identity.uid },
      email: identity.email ? { stringValue: identity.email } : { nullValue: null },
      message: { stringValue: message },
      route: { stringValue: route },
      // Server clock, not the client's — a submission cannot backdate itself.
      createdAt: { timestampValue: new Date().toISOString() },
    },
  };
}

export async function POST(req: Request): Promise<Response> {
  const cfg = firebaseServerConfig();
  if (!cfg) {
    // Self-hosted without Firebase. Say so plainly rather than 500-ing: the
    // studio hides the affordance in this case, so reaching here is a direct
    // call, and a direct caller deserves the real reason.
    return jsonError("feedback is not configured on this deployment", 503);
  }

  const raw = await readCappedText(req, MAX_BODY_BYTES);
  if (raw instanceof Response) return raw;

  const body = (() => {
    try {
      return JSON.parse(raw) as { idToken?: unknown; message?: unknown; route?: unknown };
    } catch {
      return null;
    }
  })();
  if (!body || typeof body !== "object") return jsonError("malformed request body", 400);

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return jsonError("feedback cannot be empty", 400);
  if (message.length > MAX_MESSAGE_CHARS) {
    return jsonError(`feedback is limited to ${MAX_MESSAGE_CHARS} characters`, 400);
  }

  const route =
    typeof body.route === "string" ? body.route.trim().slice(0, MAX_ROUTE_CHARS) : "";

  const idToken = typeof body.idToken === "string" ? body.idToken : "";
  if (!idToken) return jsonError("sign in to send feedback", 401);

  const identity = await identityFor(idToken, cfg.apiKey);
  if (!identity) return jsonError("sign in to send feedback", 401);

  let write: Response;
  try {
    write = await fetch(
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents/feedback`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The USER'S token — the deployed Firestore rules judge this write
          // the same way they judge every client-side write in the app.
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(documentFor(identity, message, route)),
        cache: "no-store",
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      },
    );
  } catch {
    return jsonError("feedback store unreachable", 503);
  }

  if (!write.ok) {
    // A rules refusal is the likely 403 here, and it is a DEPLOYMENT fact, not
    // something the writer did wrong — name it rather than blaming the text.
    if (write.status === 403) return jsonError("this deployment is not accepting feedback", 503);
    return jsonError("feedback could not be saved", 502);
  }

  const saved = (await write.json().catch(() => null)) as { name?: unknown } | null;
  const id = typeof saved?.name === "string" ? saved.name.split("/").pop() ?? "" : "";
  return new Response(JSON.stringify({ ok: true, id } satisfies FeedbackAccepted), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
