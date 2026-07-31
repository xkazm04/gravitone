// Server-only: what this deployment says about ITSELF to a machine.
//
// Both machine-facing documents — the per-key manifest and
// /.well-known/gravitone.json — have to answer "which host should the agent
// call?", and the honest answer is not obvious. `GRAVITONE_URL` is the address
// the STUDIO uses to reach the backend, which on a normal install is
// http://127.0.0.1:8080 — correct for the studio process and useless to an
// agent running anywhere else. So the base URL is reported together with WHERE
// IT CAME FROM, and an operator-set `GRAVITONE_PUBLIC_URL` always wins.
//
// Never import from a client component: these values are the server's.

export type BaseUrl = {
  url: string;
  /** Which setting produced it — rendered next to it, never hidden. */
  source: "GRAVITONE_PUBLIC_URL" | "GRAVITONE_URL" | "default";
  /** Empty when the operator named a public URL; a caveat otherwise. */
  caveat: string;
};

const LOOPBACK_CAVEAT =
  "This is the address the studio uses to reach the backend, not necessarily one an agent can reach. " +
  "Set GRAVITONE_PUBLIC_URL to the host your agents should call.";

export function baseUrl(): BaseUrl {
  const pub = process.env.GRAVITONE_PUBLIC_URL;
  if (pub) return { url: pub.replace(/\/+$/, ""), source: "GRAVITONE_PUBLIC_URL", caveat: "" };
  const internal = process.env.GRAVITONE_URL;
  if (internal) return { url: internal.replace(/\/+$/, ""), source: "GRAVITONE_URL", caveat: LOOPBACK_CAVEAT };
  return { url: "http://127.0.0.1:8080", source: "default", caveat: LOOPBACK_CAVEAT };
}

/** The auth block every machine-facing document repeats, written once.
 *
 *  It states the thing a client would otherwise discover by being served
 *  without a key: enforcement is ON only when TTS_API_KEY is set on the
 *  service (service/auth.py). The keys page measures which of the two this
 *  deployment is; a static document must not claim to know. */
export const AUTH = {
  header: "xi-api-key",
  alternate: "Authorization: Bearer <key>",
  note:
    "The ElevenLabs-compatible header. This deployment only CHECKS it when TTS_API_KEY is set on the " +
    "service; with it unset every request is served unauthenticated. The studio's keys page measures " +
    "which of the two this box is — nothing in this document can tell you.",
} as const;
