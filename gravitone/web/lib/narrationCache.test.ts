import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLIPS_STORE, cacheAvailable, clearClips, countClips, getClip, putClip,
  resetNarrationCache,
} from "./narrationCache";

// ── a minimal IndexedDB, in memory ───────────────────────────────────────────
//
// jsdom ships none, and the repo takes no new dependencies for a test. This
// implements exactly the surface narrationCache uses — open/upgrade, a keyPath
// store, get/put/clear/count, and an index cursor for the LRU prune — with the
// asynchrony that matters: every request resolves on a later task, and a
// transaction completes only once nothing is pending (which is what makes
// `cursor.continue()` inside a delete loop behave like the real thing).

type Rec = { key: string; at: number; [k: string]: unknown };

class FakeTx {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: unknown = null;
  private pending = 0;
  constructor(private readonly db: FakeDb) {}

  objectStore() {
    return new FakeStore(this.db, this);
  }

  /** Run a request's callback on a later task, then settle the transaction
   *  once no further work was queued from inside it. */
  schedule(run: () => void) {
    this.pending += 1;
    setTimeout(() => {
      run();
      this.pending -= 1;
      setTimeout(() => {
        if (this.pending === 0) this.oncomplete?.();
      }, 0);
    }, 0);
  }
}

class FakeCursor {
  constructor(
    private readonly rows: Rec[],
    private i: number,
    private readonly db: FakeDb,
    private readonly tx: FakeTx,
    private readonly req: FakeRequest,
  ) {}
  get value() { return this.rows[this.i]; }
  delete() { this.db.data.delete(this.rows[this.i].key); }
  continue() {
    const next = this.i + 1;
    this.tx.schedule(() => {
      this.req.result = next < this.rows.length
        ? new FakeCursor(this.rows, next, this.db, this.tx, this.req)
        : null;
      this.req.onsuccess?.();
    });
  }
}

class FakeRequest {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
  result: unknown = null;
  error: unknown = null;
}

class FakeStore {
  constructor(private readonly db: FakeDb, private readonly tx: FakeTx) {}
  get(key: string) {
    const req = new FakeRequest();
    this.tx.schedule(() => {
      req.result = this.db.data.get(key) ?? undefined;
      req.onsuccess?.();
    });
    return req as unknown as IDBRequest;
  }
  put(rec: Rec) {
    const req = new FakeRequest();
    this.tx.schedule(() => {
      this.db.data.set(rec.key, rec);
      req.onsuccess?.();
    });
    return req as unknown as IDBRequest;
  }
  clear() {
    const req = new FakeRequest();
    this.tx.schedule(() => {
      this.db.data.clear();
      req.onsuccess?.();
    });
    return req as unknown as IDBRequest;
  }
  count() {
    const req = new FakeRequest();
    this.tx.schedule(() => {
      req.result = this.db.data.size;
      req.onsuccess?.();
    });
    return req as unknown as IDBRequest;
  }
  createIndex() { /* declared at upgrade; the fake indexes lazily */ }
  index(name: string) {
    const db = this.db;
    const tx = this.tx;
    return {
      openCursor() {
        const req = new FakeRequest();
        const rows = [...db.data.values()].sort(
          (a, b) => Number(a[name] ?? 0) - Number(b[name] ?? 0));
        tx.schedule(() => {
          req.result = rows.length ? new FakeCursor(rows, 0, db, tx, req) : null;
          req.onsuccess?.();
        });
        return req as unknown as IDBRequest;
      },
    };
  }
}

class FakeDb {
  data = new Map<string, Rec>();
  stores = new Set<string>();
  objectStoreNames = { contains: (n: string) => this.stores.has(n) };
  createObjectStore(name: string) {
    this.stores.add(name);
    return new FakeStore(this, new FakeTx(this));
  }
  transaction() {
    return new FakeTx(this) as unknown as IDBTransaction;
  }
}

let db: FakeDb;

function installFakeIndexedDb() {
  db = new FakeDb();
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open() {
      const req = new FakeRequest();
      setTimeout(() => {
        req.result = db;
        if (!db.stores.has(CLIPS_STORE)) req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  resetNarrationCache();
}

function removeIndexedDb() {
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
  resetNarrationCache();
}

afterEach(removeIndexedDb);

describe("with storage available", () => {
  beforeEach(installFakeIndexedDb);

  it("round-trips a rendered clip by content hash", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
    expect(await putClip("hash-a", blob)).toBe(true);

    const back = await getClip("hash-a");
    expect(back).not.toBeNull();
    expect(back!.key).toBe("hash-a");
    expect(back!.type).toBe("audio/wav");
    expect(await back!.blob.arrayBuffer()).toEqual(await blob.arrayBuffer());
  });

  it("misses cleanly on an unknown hash — a miss is null, never a throw", async () => {
    expect(await getClip("never-rendered")).toBeNull();
  });

  it("labels a typeless blob rather than storing an empty content type", async () => {
    await putClip("hash-b", new Blob(["x"]));
    expect((await getClip("hash-b"))!.type).toBe("audio/wav");
  });

  it("counts what it holds and clears on request", async () => {
    await putClip("h1", new Blob(["a"]));
    await putClip("h2", new Blob(["b"]));
    expect(await countClips()).toBe(2);
    await clearClips();
    expect(await countClips()).toBe(0);
    expect(await getClip("h1")).toBeNull();
  });

  it("overwrites rather than duplicating the same hash", async () => {
    await putClip("same", new Blob(["a"]));
    await putClip("same", new Blob(["bb"]));
    expect(await countClips()).toBe(1);
    expect((await getClip("same"))!.blob.size).toBe(2);
  });

  it("touches the LRU stamp on a hit, so a replayed clip is not the next evicted",
    async () => {
      await putClip("old", new Blob(["a"]));
      const first = db.data.get("old")!.at as number;
      db.data.get("old")!.at = first - 10_000; // age it
      await getClip("old");
      // The touch is fire-and-forget; give it its task.
      await new Promise((r) => setTimeout(r, 5));
      expect(db.data.get("old")!.at).toBeGreaterThan(first - 10_000);
    });

  it("reports itself available", () => {
    expect(cacheAvailable()).toBe(true);
  });
});

describe("with storage unavailable (private mode, quota off, jsdom)", () => {
  beforeEach(removeIndexedDb);

  // The opposite policy to lib/playgroundDb on purpose: narration audio is
  // re-derivable, so a browser without storage must still be able to LISTEN.
  it("misses instead of throwing", async () => {
    expect(await getClip("anything")).toBeNull();
  });

  it("reports the write did NOT land, so the dock can say so", async () => {
    expect(await putClip("x", new Blob(["a"]))).toBe(false);
  });

  it("latches unavailable after the first failed open", async () => {
    await getClip("x");
    expect(cacheAvailable()).toBe(false);
  });

  it("counts zero and clears without throwing", async () => {
    expect(await countClips()).toBe(0);
    await expect(clearClips()).resolves.toBeUndefined();
  });
});
