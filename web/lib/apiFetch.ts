// Client-side counterpart of lib/backend#jsonError: ONE way to turn a non-OK
// /api/* response into an error the UI can show. Previously four modules
// reimplemented this (characters.ts throwDetail, keys/data.ts inline, the
// ingest page, engine.ts) with different json-parse ordering — the unguarded
// variants surfaced raw SyntaxErrors to users when a proxy returned non-JSON.
//
// Rules encoded here:
//   - parse the body defensively (.json().catch) BEFORE trusting it
//   - prefer the backend's `detail` (it is written to be user-showable)
//   - 503 always reads "Gravitone backend unreachable"
//   - the status survives on the thrown error so callers can branch (429, 404)

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** Best-effort extraction of the backend's `detail` from a response. */
export async function readDetail(r: Response): Promise<string | undefined> {
  const body = await r.json().catch(() => ({} as { detail?: unknown }));
  return typeof body?.detail === "string" ? body.detail : undefined;
}

/** Throw an ApiError carrying the backend detail (or a sensible fallback). */
export async function throwDetail(r: Response, fallback: string): Promise<never> {
  const detail = await readDetail(r);
  throw new ApiError(
    detail ?? (r.status === 503 ? "Gravitone backend unreachable" : fallback),
    r.status,
  );
}

/** fetch → ok-check → parsed JSON, with the error contract above. */
export async function apiJson<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallback: string,
): Promise<T> {
  const r = await fetch(input, init);
  if (!r.ok) return throwDetail(r, fallback);
  return (await r.json()) as T;
}
