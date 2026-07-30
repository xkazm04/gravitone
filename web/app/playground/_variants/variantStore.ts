"use client";

// Punch-in variants: the A/B lanes for ONE region of one take.
//
// A retake costs a CPU render, so losing the lanes to a refresh mid-audition
// costs the user the one thing this feature exists to save. They are persisted
// in the playground's IndexedDB (lib/playgroundDb, a third store beside takes
// and the composer) — but they are candidates, not work: only the lane the user
// commits becomes a Take, so they are capped hard and pruned on every write, and
// a discarded region's lanes are deleted outright.
//
// Failures REACH THE CALLER, like takeStore's: the console has one honest
// storage banner and "your lanes are not being kept" belongs in it.

import { openDb, runTx, VARIANTS_STORE } from "@/lib/playgroundDb";
import type { Segment } from "./shared";

/** Lane labels, in the order they are handed out. Matches the X/Y vocabulary the
 *  rest of the studio uses for an A/B comparison (TakePlayer label). */
export const LANES = ["X", "Y", "Z"] as const;
export type Lane = (typeof LANES)[number];

/** How many lanes one region may hold. Three is the audition the ear can
 *  actually hold; more is a directory, not a comparison. */
export const MAX_LANES_PER_REGION = LANES.length;

/** Total variants kept across the whole store. Each holds its own audio, so this
 *  is the number that decides whether the editor can exhaust a quota. */
export const MAX_STORED_VARIANTS = 18;

export type Variant = {
  /** `${takeId}::${regionIndex}::${lane}` — one record per lane per region. */
  id: string;
  takeId: string;
  regionIndex: number;
  lane: Lane;
  /** The raw (metatagged) text this lane rendered — the patch call's body. */
  text: string;
  /** Per-region emotion override, if the user picked one. */
  emotion?: string;
  characterId: string;
  characterName: string;
  seconds: number;
  segments: Segment[];
  createdAt: number;
  blob: Blob;
  /** Session-scoped object URL, minted on read and owned by the caller. Never
   *  stored (it would be a dangling string in the next session). */
  url?: string;
};

type StoredVariant = Omit<Variant, "url">;

export function variantId(takeId: string, regionIndex: number, lane: Lane): string {
  return `${takeId}::${regionIndex}::${lane}`;
}

function getAll(db: IDBDatabase): Promise<StoredVariant[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(VARIANTS_STORE, "readonly").objectStore(VARIANTS_STORE).getAll();
    req.onsuccess = () => resolve((req.result as StoredVariant[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("read failed"));
  });
}

/** Persist one lane. THROWS when it could not be stored — the caller says so
 *  (the lane is still playable in this session; it just is not durable). */
export async function putVariant(v: Variant): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const { url: _url, ...rest } = v;
    await runTx(db, VARIANTS_STORE, "readwrite", (store) => store.put(rest));
    // Prune AFTER the write, and never report a failed prune as a failed save.
    try {
      const all = await getAll(db);
      if (all.length > MAX_STORED_VARIANTS) {
        all.sort((a, b) => b.createdAt - a.createdAt);
        const stale = all.slice(MAX_STORED_VARIANTS).map((r) => r.id);
        await runTx(db, VARIANTS_STORE, "readwrite", (store) => stale.forEach((id) => store.delete(id)));
      }
    } catch {
      /* the cap is housekeeping — the lane is stored either way */
    }
  } finally {
    db?.close();
  }
}

/** Every stored lane for one take's region, oldest lane first, each with a fresh
 *  object URL the caller owns. */
export async function getVariants(takeId: string, regionIndex: number): Promise<Variant[]> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const all = await getAll(db);
    return all
      .filter((v) => v.takeId === takeId && v.regionIndex === regionIndex)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((v) => ({ ...v, url: v.blob ? URL.createObjectURL(v.blob) : undefined }));
  } finally {
    db?.close();
  }
}

/** Drop the lanes for one region (or for a whole take when `regionIndex` is
 *  omitted). Best-effort: a committed take does not depend on this. */
export async function dropVariants(takeId: string, regionIndex?: number): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const all = await getAll(db);
    const doomed = all
      .filter((v) => v.takeId === takeId && (regionIndex === undefined || v.regionIndex === regionIndex))
      .map((v) => v.id);
    if (doomed.length === 0) return;
    await runTx(db, VARIANTS_STORE, "readwrite", (store) => doomed.forEach((id) => store.delete(id)));
  } catch {
    /* best-effort */
  } finally {
    db?.close();
  }
}

/** The next free lane label for a region, or null when it is full. */
export function nextLane(used: readonly Lane[]): Lane | null {
  return LANES.find((l) => !used.includes(l)) ?? null;
}
