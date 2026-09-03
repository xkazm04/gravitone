// Content-Security-Policy and the frame policy, which are the two headers this
// app cannot state once and be done with — the embed route is deliberately
// framable by strangers while everything else must not be. That path-dependence
// is why they live here rather than in next.config.mjs's static `headers()`
// (which holds the headers that are the same everywhere: HSTS, nosniff,
// Referrer-Policy, Permissions-Policy).
//
// ── The frame decision ──────────────────────────────────────────────────────
//
// `/t/{id}/embed` is a SHIPPED feature: an iframe-sized Voice Card meant to be
// pasted into someone else's page ("the brand aesthetic travels wherever the
// audio does"). A blanket `X-Frame-Options: DENY` would silently kill it, so:
//
//   * every other path — `frame-ancestors 'self'` + `X-Frame-Options:
//     SAMEORIGIN`. The studio, the keys ledger and the API routes cannot be
//     framed by an attacker's page, which is what clickjacking needs;
//   * the embed path — `frame-ancestors *` and NO X-Frame-Options at all
//     (there is no wildcard-allow value for it; the header's absence is the
//     permission). The page shows one published take and holds no session
//     authority: it renders a card and plays audio. Nothing on it can be
//     clicked to a user's detriment, which is the whole clickjacking premise.
//
// ── The CSP decisions, each one paid for ────────────────────────────────────
//
// `script-src` keeps `'unsafe-inline'`. Next's App Router bootstraps and
// streams via inline <script> tags; locking them down means a per-request nonce
// from middleware, which forces EVERY page to render dynamically and gives up
// static optimization for the whole marketing surface. Not a trade this app
// should make to protect against inline injection it does not have — the
// hazard here would be reflected user content in the DOM, and the studio
// renders through React, which escapes it. `'unsafe-eval'` is added in dev
// ONLY, where the HMR runtime needs it; production gets neither.
//
// `https://apis.google.com` is in `script-src` for Firebase Auth: the popup
// flow degrades to a full-page redirect (lib/useAuth.tsx handles blocked
// popups), and the redirect path loads Google's gapi iframe helper. Without it
// a user whose browser blocks popups can never sign in — the failure mode would
// look like a broken account system, not a security control.
//
// `frame-src` names the Firebase auth domain because that same flow mounts a
// hidden iframe on it. The POPUP itself needs no directive: CSP has never had
// one for `window.open` targets.
//
// `connect-src` allows `https:` and `wss:` rather than an origin list, and this
// is the honest limit of a CSP here: the TTS backend's address is deployment
// configuration (GRAVITONE_URL / GRAVITONE_PUBLIC_URL), the live-conversation
// socket is a ticketed `wss://` URL the SERVICE mints at runtime, and Firebase
// speaks to several Google hosts. An allowlist we cannot compute at build time
// would either be wrong or be maintained by disabling it. What this still buys:
// no plaintext `http:` exfiltration, and no `ws:`.

/** The embeddable Voice Card — the one surface anyone may frame. */
export const EMBED_PATH = /^\/t\/[^/]+\/embed\/?$/;

export function contentSecurityPolicy(pathname: string, dev = false): string {
  const embeddable = EMBED_PATH.test(pathname);
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    `frame-ancestors ${embeddable ? "*" : "'self'"}`,
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""} https://apis.google.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    // Takes are proxied through this origin, but a deployment may also serve
    // audio straight from the service host.
    "media-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "connect-src 'self' https: wss:",
    "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
    "upgrade-insecure-requests",
  ].join("; ");
}
