// Where the path-dependent security headers are applied. The policy itself —
// and the reasoning behind every directive in it — lives in
// lib/securityHeaders.ts, which is where the tests can reach it.

import { NextResponse, type NextRequest } from "next/server";

import { contentSecurityPolicy, EMBED_PATH } from "@/lib/securityHeaders";

export function middleware(req: NextRequest): NextResponse {
  const res = NextResponse.next();
  const { pathname } = req.nextUrl;
  res.headers.set(
    "Content-Security-Policy",
    contentSecurityPolicy(pathname, process.env.NODE_ENV !== "production"),
  );
  // Belt and braces for the browsers that still read it; ABSENT on the embed,
  // where its absence is what permits the feature.
  if (!EMBED_PATH.test(pathname)) res.headers.set("X-Frame-Options", "SAMEORIGIN");
  return res;
}

export const config = {
  // Everything a person or a client actually requests. Static assets and the
  // image optimizer are excluded: they are immutable bytes served from this
  // origin, and a CSP on a .woff2 protects nothing while costing a middleware
  // invocation per file.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
