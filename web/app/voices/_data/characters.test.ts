import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The data layer's hooks pull in Firebase auth, which refuses to initialize
// without real keys. Only the request layer is under test here.
vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({ recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }) }));

// loadRoster is module-level state (one shared in-flight request), so every
// test gets a fresh module instance.
async function freshModule() {
  vi.resetModules();
  return import("./characters");
}

function rosterResponse(names: string[] = ["sarah"]): Response {
  return new Response(JSON.stringify(names.map((n) => ({ character_id: n, name: n }))), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

/** A fetch that resolves only when the test says so, and records every call's
 *  init (so the abort tests can inspect the signal it was given). */
function deferredFetch() {
  const calls: RequestInit[] = [];
  const releases: Array<(r: Response) => void> = [];
  const f = vi.fn((_u: unknown, init: RequestInit) => {
    calls.push(init);
    return new Promise<Response>((res) => { releases.push(res); });
  });
  return { f, calls, release: (r: Response, i = 0) => releases[i](r) };
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("loadRoster — one shared request", () => {
  it("serves concurrent callers from ONE request", async () => {
    const { f, release } = deferredFetch();
    vi.stubGlobal("fetch", f);
    const { loadRoster } = await freshModule();

    const a = loadRoster();
    const b = loadRoster();
    release(rosterResponse());
    expect(await a).toEqual(await b);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache: a load after the first settles asks the server again", async () => {
    // The staleness guard. A time-based cache here is how an earlier round
    // shipped a roster that stayed stale after a clone — every mount must see
    // server truth.
    const f = vi.fn().mockImplementation(() => Promise.resolve(rosterResponse()));
    vi.stubGlobal("fetch", f);
    const { loadRoster } = await freshModule();

    await loadRoster();
    await loadRoster();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("invalidateRoster detaches an in-flight request from later callers", async () => {
    // A mutation landed while a roster read was in flight: serving that read to
    // the post-mutation caller would hand back pre-mutation truth.
    const { f, release } = deferredFetch();
    vi.stubGlobal("fetch", f);
    const { loadRoster, invalidateRoster } = await freshModule();

    const first = loadRoster();
    invalidateRoster();
    void loadRoster().catch(() => {});
    expect(f).toHaveBeenCalledTimes(2);
    release(rosterResponse());
    expect(await first).toHaveLength(1);
  });
});

describe("loadRoster — abort", () => {
  it("rejects the caller and cancels the request when nobody else is waiting", async () => {
    const { f, calls } = deferredFetch();
    vi.stubGlobal("fetch", f);
    const { loadRoster } = await freshModule();

    const ctrl = new AbortController();
    const p = loadRoster(ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0].signal!.aborted).toBe(true);
  });

  it("does not cancel a request another caller is still waiting for", async () => {
    // A shared request must not be pulled out from under a second component.
    const { f, calls, release } = deferredFetch();
    vi.stubGlobal("fetch", f);
    const { loadRoster } = await freshModule();

    const ctrl = new AbortController();
    const aborted = loadRoster(ctrl.signal);
    const other = loadRoster();
    ctrl.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0].signal!.aborted).toBe(false);
    release(rosterResponse(["sarah", "milo"]));
    expect(await other).toHaveLength(2);
  });

  it("rejects an already-aborted caller without issuing a request", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { loadRoster } = await freshModule();
    await expect(loadRoster(AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(f).not.toHaveBeenCalled();
  });
});
