// Published takes: the payload shape + the one server-side loader.
//
// The share page, the embed page and the metadata proxy each inlined the same
// backendFetch -> `r.ok ? json : null` -> `catch -> null` block. Three copies
// meant any change — the read timeout, the cache mode, a new backend shape, how
// a missing take is treated — had to land in three places and could silently
// drift (the embed and share pages disagreeing on a missing take).

import { backendFetch, READ_TIMEOUT_MS } from "./backend";

/** One segment of a published take, as the store holds it.
 *
 *  The CAST pair is optional at every layer and absent together: a solo take
 *  names one Character at the top level and nobody per segment, and every take
 *  published before segments carried a speaker has neither key on disk. Present
 *  = "this segment was spoken by this Character"; absent = "this take names no
 *  cast", which is NOT the same as "one voice" — a take published before the
 *  cast existed may well have been an ensemble, and nothing here can tell. */
export type SharedSegment = {
  text: string;
  requested: string;
  used: string;
  fallback: boolean;
  seconds: number;
  character_id?: string;
  character_name?: string;
};

/** Who a take cast, id → display name, in first-spoken order. Empty when the
 *  take names no cast (see SharedSegment). */
export function castOf(take: Pick<SharedTake, "segments">): Map<string, string> {
  const cast = new Map<string, string>();
  for (const s of take.segments) {
    if (s.character_id && !cast.has(s.character_id)) {
      cast.set(s.character_id, s.character_name || s.character_id);
    }
  }
  return cast;
}

export type SharedTake = {
  id: string;
  character_id: string;
  character_name: string;
  text: string;
  seconds: number;
  rtf: number;
  segments: SharedSegment[];
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
      credential: "operator",
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    return r.ok ? ((await r.json()) as TakeLineage) : null;
  } catch {
    return null;
  }
}

/**
 * The three answers a share link can honestly get.
 *
 * `gone` and `unreachable` used to be one null, and every caller turned that
 * null into a 404 page. So during a backend restart — a deploy, an OOM, a
 * stopped container — every live share link on the internet told its visitor
 * the take DID NOT EXIST. It does exist; this studio just could not read it,
 * and those are not the same sentence to a person who was sent that link. The
 * distinction is also the difference between a permanent answer (a crawler may
 * drop the URL, the visitor should stop retrying) and a temporary one.
 *
 * `detail` carries what the read actually failed with, through the same
 * backend `detail` contract the rest of the studio reports failures in.
 */
export type TakeLoad =
  | { status: "ok"; take: SharedTake }
  | { status: "gone" }
  | { status: "unreachable"; detail: string };

/** Fetch one published take server-side, saying WHICH failure happened.
 *
 *  gone         — the backend answered, and this take is not there (missing, or
 *                 evicted from the bounded store). A permanent 404.
 *  unreachable  — the backend never answered, or answered with a server error /
 *                 the studio's own 503. The take may be perfectly fine.
 */
export async function loadTake(id: string): Promise<TakeLoad> {
  let r: Response;
  try {
    r = await backendFetch(`/v1/takes/${encodeURIComponent(id)}`, {
      credential: "operator",
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    // No response at all: connection refused, DNS, or the read timeout fired.
    return { status: "unreachable", detail: "Gravitone backend unreachable" };
  }
  if (r.status === 404) return { status: "gone" };
  if (!r.ok) {
    return { status: "unreachable", detail: await readTakeDetail(r) };
  }
  try {
    return { status: "ok", take: (await r.json()) as SharedTake };
  } catch {
    // A 200 whose body is not JSON is a broken backend, not a missing take.
    return { status: "unreachable", detail: "the backend answered with an unreadable take" };
  }
}

/** The backend's own sentence for a failed read, defensively parsed — the same
 *  contract lib/apiFetch applies on the client, applied here because this read
 *  happens on the server and cannot use it. */
async function readTakeDetail(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as { detail?: unknown };
    if (typeof body?.detail === "string" && body.detail) return body.detail;
  } catch {
    /* not JSON — fall through to the status sentence */
  }
  return r.status === 503
    ? "Gravitone backend unreachable"
    : `the backend answered ${r.status} for this take`;
}
