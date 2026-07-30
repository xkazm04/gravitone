import { describe, expect, it } from "vitest";
import {
  LOCAL_ENGINE_WEIGHTS_MB, STORAGE_HEADROOM_MB, probeLocalEngine, type ProbeEnv,
} from "./engineProbe";

// The matrix. Every row is a real browser shape, and the assertions are about
// HONESTY as much as detection: an unknown must stay unknown, and a capability
// nobody asked about must not turn into a "no".

const MB = 1024 * 1024;

/** A browser with everything. */
function ideal(over: Partial<ProbeEnv> = {}): ProbeEnv {
  return {
    wasm: WebAssembly,
    crossOriginIsolated: true,
    sharedArrayBuffer: SharedArrayBuffer,
    navigator: {
      deviceMemory: 8,
      gpu: {},
      storage: { estimate: async () => ({ quota: 4096 * MB, usage: 100 * MB }) },
    },
    ...over,
  };
}

const signal = (r: Awaited<ReturnType<typeof probeLocalEngine>>, id: string) =>
  r.signals.find((s) => s.id === id)!;

describe("a browser with everything", () => {
  it("is capable, with nothing missing and nothing unknown", async () => {
    const r = await probeLocalEngine(ideal());
    expect(r.capable).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it("still says out loud that no engine was downloaded or run", async () => {
    const r = await probeLocalEngine(ideal());
    expect(r.notes[0]).toMatch(/not shipped yet/);
  });

  it("detects real WASM SIMD through validate (not a version sniff)", async () => {
    expect(signal(await probeLocalEngine(ideal()), "simd").ok).toBe(true);
  });
});

describe("required signals", () => {
  it("a browser with no WebAssembly is not capable, and SIMD is a no rather than unknown", async () => {
    const r = await probeLocalEngine(ideal({ wasm: undefined }));
    expect(r.capable).toBe(false);
    expect(r.missing).toContain("wasm");
    expect(signal(r, "simd").ok).toBe(false);
  });

  it("no SIMD kills capability even when everything else is present", async () => {
    const noSimd = { validate: () => false } as unknown as typeof WebAssembly;
    const r = await probeLocalEngine(ideal({ wasm: noSimd }));
    expect(r.capable).toBe(false);
    expect(r.missing).toEqual(["simd"]);
    expect(signal(r, "simd").detail).toMatch(/Safari before 16.4/);
  });

  it("a validate() that throws is unknown — and unknown is NOT capable", async () => {
    const broken = { validate: () => { throw new Error("nope"); } } as unknown as typeof WebAssembly;
    const r = await probeLocalEngine(ideal({ wasm: broken }));
    expect(signal(r, "simd").ok).toBeNull();
    expect(r.unknown).toContain("simd");
    expect(r.capable).toBe(false);
  });
});

describe("threads and isolation", () => {
  it("needs BOTH SharedArrayBuffer and cross-origin isolation", async () => {
    const noIso = await probeLocalEngine(ideal({ crossOriginIsolated: false }));
    expect(signal(noIso, "threads").ok).toBe(false);
    expect(signal(noIso, "threads").detail).toMatch(/COOP\/COEP/);

    const noSab = await probeLocalEngine(ideal({ sharedArrayBuffer: undefined }));
    expect(signal(noSab, "threads").ok).toBe(false);
    expect(signal(noSab, "threads").detail).toMatch(/single-threaded/);
  });

  it("missing threads does not make the browser incapable — it makes it slow", async () => {
    const r = await probeLocalEngine(ideal({ crossOriginIsolated: false }));
    expect(r.capable).toBe(true);
    expect(r.missing).toEqual(["threads"]);
    expect(r.notes.join(" ")).toMatch(/Single-threaded WASM is the fallback/);
  });
});

describe("WebGPU is optional and says so", () => {
  it("is reported absent without counting as missing", async () => {
    const r = await probeLocalEngine(ideal({
      navigator: { deviceMemory: 8, storage: { estimate: async () => ({ quota: 4096 * MB, usage: 0 }) } },
    }));
    expect(signal(r, "webgpu").ok).toBe(false);
    expect(r.missing).not.toContain("webgpu");
    expect(r.capable).toBe(true);
  });

  it("does not claim a present API proves a usable GPU", async () => {
    expect(signal(await probeLocalEngine(ideal()), "webgpu").detail)
      .toMatch(/adapter is not requested/);
  });
});

describe("storage — the number that lies", () => {
  it("fails when the free quota cannot hold the weights plus headroom", async () => {
    const r = await probeLocalEngine(ideal({
      navigator: {
        deviceMemory: 8, gpu: {},
        storage: { estimate: async () => ({ quota: 100 * MB, usage: 10 * MB }) },
      },
    }));
    expect(signal(r, "storage").ok).toBe(false);
    expect(r.missing).toContain("storage");
    // ...and still capable: storage is recommended, not required — the weights
    // could stream on a device that will not cache them.
    expect(r.capable).toBe(true);
  });

  it("passes on exactly the headroom boundary and names the quota as policy", async () => {
    const r = await probeLocalEngine(ideal({
      navigator: {
        deviceMemory: 8, gpu: {},
        storage: { estimate: async () => ({ quota: STORAGE_HEADROOM_MB * MB, usage: 0 }) },
      },
    }));
    expect(signal(r, "storage").ok).toBe(true);
    expect(signal(r, "storage").detail).toMatch(/browser POLICY number/);
  });

  it("stays unknown when the browser exposes no estimate at all (Safari)", async () => {
    const r = await probeLocalEngine(ideal({ navigator: { deviceMemory: undefined, gpu: {} } }));
    expect(signal(r, "storage").ok).toBeNull();
    expect(r.unknown).toContain("storage");
    expect(r.notes.join(" ")).toMatch(/Safari reports no usable storage estimate/);
  });

  it("stays unknown when estimate() rejects, instead of reading as 'no space'", async () => {
    const r = await probeLocalEngine(ideal({
      navigator: {
        deviceMemory: 8, gpu: {},
        storage: { estimate: async () => { throw new Error("denied"); } },
      },
    }));
    expect(signal(r, "storage").ok).toBeNull();
    expect(signal(r, "storage").detail).toMatch(/failed/);
  });

  it("mentions the weight estimate the headroom is derived from", async () => {
    const r = await probeLocalEngine(ideal());
    expect(signal(r, "storage").detail).toContain(`${LOCAL_ENGINE_WEIGHTS_MB} MB`);
  });
});

describe("device memory — a Chromium-only bucket", () => {
  it("fails a small device", async () => {
    const r = await probeLocalEngine(ideal({
      navigator: { deviceMemory: 1, gpu: {}, storage: { estimate: async () => ({ quota: 4096 * MB, usage: 0 }) } },
    }));
    expect(signal(r, "memory").ok).toBe(false);
    expect(r.missing).toContain("memory");
  });

  it("is unknown — never 'no' — where the API does not exist", async () => {
    const r = await probeLocalEngine(ideal({
      navigator: { gpu: {}, storage: { estimate: async () => ({ quota: 4096 * MB, usage: 0 }) } },
    }));
    expect(signal(r, "memory").ok).toBeNull();
    expect(r.missing).not.toContain("memory");
    expect(r.notes.join(" ")).toMatch(/Firefox and Safari do not expose device memory/);
  });

  it("names the cap so 8 is not read as exactly 8", async () => {
    expect(signal(await probeLocalEngine(ideal()), "memory").detail).toMatch(/8 or more/);
  });
});

describe("a bare environment", () => {
  it("answers without throwing when there is no navigator at all (SSR-ish)", async () => {
    const r = await probeLocalEngine({ wasm: WebAssembly });
    expect(r.capable).toBe(true);          // wasm + simd are genuinely present
    expect(r.unknown).toEqual(expect.arrayContaining(["storage", "memory"]));
    expect(signal(r, "threads").ok).toBe(false);
  });

  it("reads the real globals when handed no env", async () => {
    // jsdom: WebAssembly exists, the storage/memory APIs do not.
    const r = await probeLocalEngine();
    expect(signal(r, "wasm").ok).toBe(true);
    expect(r.signals.map((s) => s.id))
      .toEqual(["wasm", "simd", "threads", "webgpu", "storage", "memory"]);
  });
});
