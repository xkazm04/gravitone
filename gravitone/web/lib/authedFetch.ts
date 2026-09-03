"use client";

// Attach the signed-in user's Firebase ID token to a studio API call.
//
// Only the key-management surfaces need this: they are the routes that mint and
// revoke credentials, so the server has to know WHO is asking (app/api/keys/
// identity.ts). Everything else in the studio is a synthesis proxy where the
// caller's identity changes nothing.
//
// Firebase is loaded LAZILY and only when a project is configured. A local
// single-user deployment has no Firebase config at all — importing the SDK
// there would pull ~200KB into the bundle to produce no header, and the server
// is in single-user mode anyway, where no token is expected.
//
// `getIdToken()` refreshes on its own when the cached token is within five
// minutes of expiry, so a long studio session keeps working without a reload.

export async function authHeaders(): Promise<Record<string, string>> {
  if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) return {};
  try {
    const { auth } = await import("./firebase");
    const user = auth.currentUser;
    if (!user) return {};
    const token = await user.getIdToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    // No token is a real answer: the route will say so with a 401 the UI
    // already renders. Failing the fetch here would turn "signed out" into
    // "the studio is broken".
    return {};
  }
}

/** `fetch`, with the caller's identity attached when there is one. */
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(await authHeaders())) headers.set(k, v);
  return fetch(input, { ...init, headers });
}
