"use client";

// Session-durable takes. A generated take lives only in component state, so a
// refresh used to destroy the whole session. This persists each take's audio
// blob + metadata to IndexedDB (raw API — no dependency) and restores the most
// recent ones on mount. Object-URL lifecycle stays with the caller: this module
// mints fresh object URLs on restore and never revokes them (the console owns
// revocation when a take is removed/replaced or the page unmounts).

import type { Take } from "@/app/playground/_variants/shared";

const DB_NAME = "gravitone-playground";
const STORE = "takes";
const DB_VERSION = 1;
// Keep the store bounded across many sessions — restore reads the most recent
// slice, and we prune anything past this cap on write.
const MAX_STORED = 50;

// What we persist: the whole take minus its (session-scoped) object URL, plus
// the raw audio blob (null for browser-fallback takes, which replay from text).
type StoredRecord = {
  id: string;
  createdAt: number;
  take: Omit<Take, "url">;
  blob: Blob | null;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run one transaction to completion, resolving when it commits. */
function runTx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    work(tx.objectStore(STORE));
  });
}

function getAllRecords(db: IDBDatabase): Promise<StoredRecord[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as StoredRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

/** Persist (or update) one take and its audio blob. Best-effort; never throws. */
export async function putTake(take: Take, blob: Blob | null): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const { url: _url, ...rest } = take;
    await runTx(db, "readwrite", (store) => {
      store.put({ id: take.id, createdAt: take.createdAt, take: rest, blob });
    });
    // Prune the oldest beyond the cap so IndexedDB does not grow unbounded.
    const all = await getAllRecords(db);
    if (all.length > MAX_STORED) {
      all.sort((a, b) => b.createdAt - a.createdAt);
      const stale = all.slice(MAX_STORED).map((r) => r.id);
      await runTx(db, "readwrite", (store) => stale.forEach((id) => store.delete(id)));
    }
  } catch {
    /* persistence is best-effort — a take still lives in component state */
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
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Remove one take from the store. Best-effort; never throws. */
export async function deleteTake(id: string): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    await runTx(db, "readwrite", (store) => store.delete(id));
  } catch {
    /* best-effort */
  } finally {
    db?.close();
  }
}
