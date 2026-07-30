"use client";

// The playground's IndexedDB. ONE database, one connection helper, one
// transaction helper — takes (lib/takeStore) and the composer
// (lib/composerStore) are two stores in it, not two mechanisms.
//
// Failures are NOT swallowed here. "Your work survives a refresh" is a promise
// the UI makes out loud, so a store that cannot be opened or written has to
// reach the caller, which has a banner for exactly that.

const DB_NAME = "gravitone-playground";
export const TAKES_STORE = "takes";
export const COMPOSER_STORE = "composer";
// Punch-in variants: the A/B lanes for one region of one take, each holding its
// own rendered audio. Kept out of the takes store because they are NOT takes —
// they are candidates, they are capped and pruned aggressively (see
// _variants/variantStore), and only the one the user commits becomes a take.
export const VARIANTS_STORE = "variants";
// v1 was takes-only; v2 adds the composer store; v3 adds punch-in variants.
// Every upgrade is additive, so an existing session's takes survive all of them.
const DB_VERSION = 3;

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TAKES_STORE)) {
        db.createObjectStore(TAKES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(COMPOSER_STORE)) {
        db.createObjectStore(COMPOSER_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(VARIANTS_STORE)) {
        db.createObjectStore(VARIANTS_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("could not open storage"));
    // A second tab holding the old version open blocks the upgrade forever;
    // say so instead of hanging on a promise that never settles.
    req.onblocked = () => reject(new Error("storage is open in another tab"));
  });
}

/** Run one transaction to completion, resolving when it commits. */
export function runTx(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("write aborted"));
    try {
      work(tx.objectStore(store));
    } catch (e) {
      // A synchronous throw (quota, DataCloneError) never reaches tx.onerror.
      reject(e);
    }
  });
}

/** Read one record by key. Resolves undefined when the key is absent. */
export function getRecord<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error("read failed"));
  });
}
