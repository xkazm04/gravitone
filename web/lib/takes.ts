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
  // Lineage. Optional on the type because every take published before
  // re-performable takes existed has neither key on disk — a child take is a
  // fork of another share (open in the rack, change a tag, re-render).
  parent_id?: string | null;
  derived_from?: Record<string, unknown> | null;
  // Publish-time consent for PUBLIC re-perform: may a visitor edit this text
  // and spend the box's CPU rendering it in this Character's voice? Optional
  // and falsy by default — a take published before the toggle existed, or by a
  // publisher who left it off, is not forkable. Forking puts new words in
  // someone's voice, so the absent answer is "no".
  allow_reperform?: boolean;
};

/** How a lineage member is reported — the compact shape, never the whole take.
 *  `missing` is the honest answer for an ancestor the bounded store has since
 *  evicted: "the parent is gone" is not "there was no parent". */
export type LineageMember = {
  id: string;
  character_id?: string;
  character_name?: string;
  seconds?: number;
  created?: string;
  derived_from?: Record<string, unknown>;
  missing?: boolean;
};

export type TakeLineage = {
  id: string;
  take?: LineageMember; // the subject itself, with its own derived_from block
  ancestors: LineageMember[]; // nearest parent first
  children: LineageMember[];
  children_total: number;
  depth_capped: boolean;
};

/** The chain a take belongs to, or null when it cannot be read.
 *
 *  Provenance is decoration on a share page: a take whose lineage call fails
 *  still renders in full, exactly as it did before lineage existed. Callers
 *  therefore treat null as "no lineage to show", never as an error to raise.
 */
export async function loadLineage(id: string): Promise<TakeLineage | null> {
  try {
    const r = await backendFetch(`/v1/takes/${encodeURIComponent(id)}/lineage`, {
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    return r.ok ? ((await r.json()) as TakeLineage) : null;
  } catch {
    return null;
  }
}

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
