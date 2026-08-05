// Server-side verification of a Firebase ID token. Server-only — never import
// from a client component.
//
// WHY THIS EXISTS AT ALL: the studio had client-side auth and no server-side
// identity. `useAuth` knows who is signed in; a route handler did not, so every
// API route treated an anonymous stranger and a signed-in user identically.
// That is fine for a proxy that only relays synthesis, and fatal for the key
// ledger, which mints and revokes credentials.
//
// WHY NOT `firebase-admin`: verifying an ID token needs one thing — Google's
// public signing certificates, which are served unauthenticated at a fixed URL.
// firebase-admin would additionally demand a SERVICE ACCOUNT (a private key in
// the environment, or workload identity) for its own initialization, which is a
// second secret for every self-hoster to provision and leak, to do a job that
// needs no secret at all. Firebase documents this exact path ("verify ID tokens
// using a third-party JWT library") for environments that hold no service
// account. So: no new dependency, no new secret, and the only configuration is
// the project id the browser bundle already carries.
//
// What is checked, all of it, on every call:
//   * the JWS signature, RS256, against the Google cert named by `kid`;
//   * `iss` === https://securetoken.google.com/<project>;
//   * `aud` === <project>  (an ID token minted for ANOTHER Firebase project is
//     a valid Google-signed JWT — audience is the whole defence);
//   * `exp` in the future and `iat`/`auth_time` not in the future (60s skew);
//   * `sub` present and shaped like a uid.
// A token failing any of these is not an identity. There is no partial pass.

import { X509Certificate, createHash, verify as verifySignature } from "node:crypto";

const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

/** Clock skew tolerated on exp/iat, in seconds. */
const SKEW_S = 60;

/** Firebase uids are opaque; every one Firebase mints is in this alphabet.
 *  Enforced because the uid becomes part of a key's stored name (the ownership
 *  tag), and an identifier that can carry separators is one that can forge an
 *  owner. */
export const UID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

export type VerifiedToken = { uid: string; email: string | null };

/** The Firebase project this deployment authenticates against, or "" when
 *  Firebase is not configured at all (see app/api/keys/identity.ts for what
 *  that means for authorization). `FIREBASE_PROJECT_ID` wins so an operator can
 *  pin the server's expectation without touching the public bundle. */
export function firebaseProjectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID ??
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??
    ""
  ).trim();
}

type CertCache = { certs: Record<string, string>; expiresAt: number };
let cache: CertCache | null = null;

/** Google's current signing certificates, cached for as long as Google says.
 *  Re-fetched on a cache miss for an unknown `kid` (key rotation), never more
 *  often than that — a token verification must not become an outbound request. */
async function signingCerts(kid: string): Promise<string | null> {
  const now = Date.now();
  if (cache && cache.expiresAt > now && cache.certs[kid]) return cache.certs[kid];
  let res: Response;
  try {
    res = await fetch(CERT_URL, { cache: "no-store" });
  } catch {
    // Google unreachable. Fall back to whatever we still hold, even if stale:
    // a cert that verified a token a minute ago is a better answer than
    // signing everyone out because of a transient network fault. If we hold
    // nothing, the caller gets "unverifiable", never "verified".
    return cache?.certs[kid] ?? null;
  }
  if (!res.ok) return cache?.certs[kid] ?? null;
  let certs: Record<string, string>;
  try {
    certs = (await res.json()) as Record<string, string>;
  } catch {
    return cache?.certs[kid] ?? null;
  }
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  cache = { certs, expiresAt: now + Math.max(60, maxAge) * 1000 };
  return certs[kid] ?? null;
}

/** Drop the cached certificates. Tests only — a module-level cache that no
 *  test can clear is a test that depends on the order it ran in. */
export function resetCertCache(): void {
  cache = null;
}

function decodeSegment(seg: string): unknown {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

/** Verify a Firebase ID token. Returns the identity, or null — never throws,
 *  and never distinguishes WHY it failed to the caller: "expired", "wrong
 *  project" and "forged" are all one answer at the boundary. */
export async function verifyIdToken(token: string): Promise<VerifiedToken | null> {
  const project = firebaseProjectId();
  if (!project || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts;

  let header: { alg?: unknown; kid?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(rawHeader) as typeof header;
    payload = decodeSegment(rawPayload) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return null;

  const pem = await signingCerts(header.kid);
  if (!pem) return null;

  let publicKey;
  try {
    publicKey = new X509Certificate(pem).publicKey;
  } catch {
    return null;
  }
  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, "utf8");
  const signature = Buffer.from(rawSignature, "base64url");
  let ok = false;
  try {
    ok = verifySignature("RSA-SHA256", signed, publicKey, signature);
  } catch {
    return null;
  }
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const exp = num(payload.exp);
  const iat = num(payload.iat);
  if (exp === null || exp <= now - SKEW_S) return null;
  if (iat === null || iat > now + SKEW_S) return null;
  const authTime = num(payload.auth_time);
  if (authTime !== null && authTime > now + SKEW_S) return null;
  if (payload.iss !== `https://securetoken.google.com/${project}`) return null;
  if (payload.aud !== project) return null;

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!UID_SHAPE.test(sub)) return null;

  return { uid: sub, email: typeof payload.email === "string" ? payload.email : null };
}

/** A stable, non-reversible short label for a uid — for logs and error copy
 *  that should not carry the identifier itself. */
export function uidFingerprint(uid: string): string {
  return createHash("sha256").update(uid).digest("base64url").slice(0, 8);
}
