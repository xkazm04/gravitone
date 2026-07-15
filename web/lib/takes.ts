// Published takes: the payload shape + the one server-side loader.
//
// The share page, the embed page and the metadata proxy each inlined the same
// backendFetch -> `r.ok ? json : null` -> `catch -> null` block. Three copies
// meant any change — the read timeout, the cache mode, a new backend shape, how
// a missing take is treated — had to land in three places and could silently
// drift (the embed and share pages disagreeing on a missing take).

import { backendFetch, READ_TIMEOUT_MS } from "./backend";

export type SharedTake = {
  id: string;
  character_id: string;
  character_name: string;
  text: string;
  seconds: number;
  rtf: number;
  segments: { text: string; requested: string; used: string; fallback: boolean; seconds: number }[];
  created: string;
};

/** Fetch one published take server-side.
 *
 *  null when it is missing, evicted from the bounded store, or the backend is
 *  unreachable/stalled (the read is timeout-bounded) — every caller renders
 *  notFound() for all three, which is the honest outcome for a share link.
 */
export async function loadTake(id: string): Promise<SharedTake | null> {
  try {
    const r = await backendFetch(`/v1/takes/${encodeURIComponent(id)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    return r.ok ? ((await r.json()) as SharedTake) : null;
  } catch {
    return null;
  }
}
