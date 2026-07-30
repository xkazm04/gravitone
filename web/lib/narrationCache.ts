"use client";

// ── The narration clip cache ─────────────────────────────────────────────────
//
// Content hash → rendered audio, in the browser. A second listen to the same
// sentence in the same voice costs zero synth slots and zero milliseconds of
// CPU on the box — which is the difference between "the site narrates itself"
// being a demo and being something that can face real traffic.
//
// Its own database, deliberately. The playground's IndexedDB (lib/playgroundDb)
// holds the user's WORK — takes, composer state, punch-in variants — and losing
// it is a real loss the studio apologises for. Narration clips are disposable
// by definition: they are re-derivable from the registry at any time. Mixing
// the two would mean a narration quota problem could evict someone's take, and
// a schema bump on either would drag the other through an upgrade. Same
// mechanics (the open/tx/get shape below mirrors playgroundDb), separate store.
//
// Failure policy — the opposite of playgroundDb's, on purpose. There, a write
// that fails breaks a promise the UI made out loud and must reach the user.
// Here the cache is an OPTIMIZATION: a browser in private mode with no
// IndexedDB should still be able to listen to the page. So every operation
// resolves to a miss/no-op instead of throwing, and the caller is told ONCE
// (`cacheAvailable`) so the dock can say "not cached this session" rather than
// silently re-synthesizing forever while pretending it did not.

const DB_NAME = "gravitone-narration";
const DB_VERSION = 1;
export const CLIPS_STORE = "clips";

/** Keep the newest N clips. A full landing-page reading is ~40 sentences, so
 *  this holds a few complete pages per narrator and still cannot grow without
 *  bound on a long browsing session. */
export const CLIP_CAP = 240;

export type NarrationClip = {
  key: string;
  blob: Blob;
  /** Content type as rendered, so playback never mislabels the bytes. */
  type: string;
  /** Last use, ms epoch — the LRU ordering. */
  at: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;
let unavailable = false;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CLIPS_STORE)) {
        const store = db.createObjectStore(CLIPS_STORE, { keyPath: "key" });
        // LRU pruning walks this index rather than reading every clip's blob
        // into memory to sort them.
        store.createIndex("at", "at");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("could not open the narration cache"));
    req.onblocked = () => reject(new Error("the narration cache is open in another tab"));
  });
  return dbPromise.catch((e) => {
    // Latch: one failed open means no IndexedDB here. Retrying on every
    // sentence would add a rejected promise to each synthesis for nothing.
    unavailable = true;
    dbPromise = null;
    throw e;
  });
}

/** False once any cache operation has proven storage is not usable here.
 *  The dock states this rather than pretending repeat listens are free. */
export function cacheAvailable(): boolean {
  return !unavailable;
}

/** Test seam + private-mode recovery: forget the latched failure and handle. */
export function resetNarrationCache(): void {
  dbPromise = null;
  unavailable = false;
}

/** The cached clip for a content hash, or null on a miss OR any cache failure.
 *  Touches `at` so the LRU reflects real use — best-effort, never awaited. */
export async function getClip(key: string): Promise<NarrationClip | null> {
  if (unavailable) return null;
  try {
    const db = await open();
    const clip = await new Promise<NarrationClip | undefined>((resolve, reject) => {
      const req = db.transaction(CLIPS_STORE, "readonly").objectStore(CLIPS_STORE).get(key);
      req.onsuccess = () => resolve(req.result as NarrationClip | undefined);
      req.onerror = () => reject(req.error ?? new Error("read failed"));
    });
    if (!clip) return null;
    void touch(db, clip).catch(() => {});
    return clip;
  } catch {
    return null;
  }
}

function touch(db: IDBDatabase, clip: NarrationClip): Promise<void> {
  return tx(db, "readwrite", (store) => store.put({ ...clip, at: Date.now() }));
}

/** Store one rendered sentence. Resolves either way — a cache that cannot be
 *  written is a slower site, not a broken one. Returns whether it landed. */
export async function putClip(key: string, blob: Blob): Promise<boolean> {
  if (unavailable) return false;
  try {
    const db = await open();
    await tx(db, "readwrite", (store) => {
      store.put({ key, blob, type: blob.type || "audio/wav", at: Date.now() } satisfies NarrationClip);
    });
    void prune(db).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Drop everything — the dock's "clear cached audio" control. */
export async function clearClips(): Promise<void> {
  if (unavailable) return;
  try {
    const db = await open();
    await tx(db, "readwrite", (store) => store.clear());
  } catch {
    /* nothing cached, or no storage at all — either way there is nothing left */
  }
}

/** How many clips are held. Shown in the dock so the cache is not a rumour. */
export async function countClips(): Promise<number> {
  if (unavailable) return 0;
  try {
    const db = await open();
    return await new Promise<number>((resolve, reject) => {
      const req = db.transaction(CLIPS_STORE, "readonly").objectStore(CLIPS_STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("count failed"));
    });
  } catch {
    return 0;
  }
}

/** Evict oldest-first down to CLIP_CAP, walking the `at` index in ascending
 *  order so only the doomed records are ever read. */
async function prune(db: IDBDatabase): Promise<void> {
  const total = await new Promise<number>((resolve, reject) => {
    const req = db.transaction(CLIPS_STORE, "readonly").objectStore(CLIPS_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("count failed"));
  });
  let excess = total - CLIP_CAP;
  if (excess <= 0) return;
  await tx(db, "readwrite", (store) => {
    const cursorReq = store.index("at").openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || excess <= 0) return;
      cursor.delete();
      excess -= 1;
      cursor.continue();
    };
  });
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(CLIPS_STORE, mode);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error("write failed"));
    t.onabort = () => reject(t.error ?? new Error("write aborted"));
    try {
      work(t.objectStore(CLIPS_STORE));
    } catch (e) {
      // A synchronous throw (quota, DataCloneError) never reaches t.onerror.
      reject(e);
    }
  });
}
