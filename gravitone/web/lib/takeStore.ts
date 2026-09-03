"use client";

// Session-durable takes. A generated take lives only in component state, so a
// refresh used to destroy the whole session. This persists each take's audio
// blob + metadata to IndexedDB (raw API — no dependency, see lib/playgroundDb)
// and restores the most recent ones on mount. Object-URL lifecycle stays with
// the caller: this module mints fresh object URLs on restore and never revokes
// them (the console owns revocation when a take is removed/replaced or the page
// unmounts).
//
// Read/write failures REACH THE CALLER. They used to be swallowed here, which
// quietly made the console's "this take could not be saved" banner unreachable
// — the log promises durability, so a broken promise has to be sayable.

import type { Take } from "@/app/playground/_variants/playgroundHelpers";
import { openDb, runTx, TAKES_STORE } from "@/lib/playgroundDb";

// Keep the store bounded across many sessions — restore reads the most recent
// slice, and we prune anything past this cap on write.
const MAX_STORED = 50;

// What we persist: the whole take minus its (session-scoped) object URL, plus
// the raw audio blob (null for browser-fallback takes, which replay from text).
type StoredRecord = {
  id: string;
  createdAt: number;
  take: Omit<Take, "url" | "blob">;
  blob: Blob | null;
};

function getAllRecords(db: IDBDatabase): Promise<StoredRecord[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(TAKES_STORE, "readonly").objectStore(TAKES_STORE).getAll();
    req.onsuccess = () => resolve((req.result as StoredRecord[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error("read failed"));
  });
}

/** Persist (or update) one take and its audio blob.
 *  THROWS when the take could not be stored — the caller says so. */
export async function putTake(take: Take, blob: Blob | null): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    // url and blob are both session-scoped views of the audio; the bytes are
    // stored ONCE, in the record's own blob field.
    const { url: _url, blob: _blob, ...rest } = take;
    await runTx(db, TAKES_STORE, "readwrite", (store) => {
      store.put({ id: take.id, createdAt: take.createdAt, take: rest, blob });
    });
    // Prune the oldest beyond the cap so IndexedDB does not grow unbounded.
    // The take IS saved at this point, so a failed prune must not be reported
    // as a failed save.
    try {
      const all = await getAllRecords(db);
      if (all.length > MAX_STORED) {
        all.sort((a, b) => b.createdAt - a.createdAt);
        const stale = all.slice(MAX_STORED).map((r) => r.id);
        await runTx(db, TAKES_STORE, "readwrite", (store) => stale.forEach((id) => store.delete(id)));
      }
    } catch {
      /* the cap is housekeeping; the user's take is stored either way */
    }
  } finally {
    db?.close();
  }
}

/**
 * Restore the most recent `limit` takes, newest first. Each take gets a fresh
 * object URL minted from its stored blob; the caller owns revoking them.
 */
export async function getRecentTakes(limit = 20): Promise<Take[]> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const records = await getAllRecords(db);
    records.sort((a, b) => b.createdAt - a.createdAt);
    return records.slice(0, limit).map((r) => ({
      ...r.take,
      url: r.blob ? URL.createObjectURL(r.blob) : undefined,
      // Restored takes carry their blob too, so sharing one after a refresh
      // publishes the bytes we just read instead of fetching the object URL.
      blob: r.blob ?? undefined,
    }));
  } finally {
    // A read failure propagates: "no takes yet" and "your saved takes could not
    // be read" are different sentences and the console prints both.
    db?.close();
  }
}

/** Remove one take from the store. Best-effort; never throws. */
export async function deleteTake(id: string): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    await runTx(db, TAKES_STORE, "readwrite", (store) => store.delete(id));
  } catch {
    /* best-effort */
  } finally {
    db?.close();
  }
}
