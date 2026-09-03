/** @type {import('next').NextConfig} */

// The headers that are the same on every path. The two that are NOT — CSP and
// the frame policy, because `/t/{id}/embed` is meant to be framed by strangers
// and nothing else is — are set in middleware.ts, which can read the path.
const SECURITY_HEADERS = [
  // Two years, subdomains included. No `preload`: that is a one-way submission
  // to a browser-shipped list, and it is the operator's call to make for their
  // domain, not a default this repo should ship on their behalf.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // The studio streams audio and downloads .gravichar packs; a browser must
  // never re-decide what a response is.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Share pages and embeds are pasted into other people's sites: the origin is
  // enough for their analytics, and a take id in a full referrer URL is a
  // private link leaking into someone else's logs.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The studio RECORDS: punch-in editing and the live conversation stage both
  // ask for the microphone, so `microphone=(self)` is a capability this app
  // genuinely needs. Everything else it does not — including on any embed it
  // is framed inside, which inherits this policy.
  {
    key: "Permissions-Policy",
    value: "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
];

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};
export default nextConfig;
