// Server-side helper for calls to the Gravitone TTS backend. Attaches the
// root API key (GRAVITONE_API_KEY in .env.local) so the key-protected
// backend accepts the studio's proxy requests; without a key configured the
// call goes out bare, matching an unprotected local backend.
// Server-only — never import from client components.

const BASE = process.env.GRAVITONE_URL ?? "http://127.0.0.1:8080";

export function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const key = process.env.GRAVITONE_API_KEY;
  if (key && !headers.has("xi-api-key")) headers.set("xi-api-key", key);
  return fetch(`${BASE}${path}`, { ...init, headers });
}
