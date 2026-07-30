// Could THIS browser host a local speech engine?
//
// The in-browser engine is not shipped. This module does not download, load or
// run anything — it feature-detects, and it is allowed to answer "I do not
// know". That last part is the whole design: every honest capability probe on
// the web has a ragged edge (Safari's storage estimate is a policy number, not
// free disk; navigator.deviceMemory exists in Chromium only and is bucketed and
// capped), and a probe that guesses through those edges produces a confident
// answer that is simply wrong on a third of devices.
//
// So a signal is `true`, `false`, or `null` = unknown, and unknowns are
// reported as unknowns all the way to the panel on /benchmarks.

/** The size of the weights a local engine would have to fetch and keep. The
 *  ONNX export does not exist yet, so this is the model's parameter count
 *  (~100M) at fp16 plus vocoder/tokenizer overhead — an ESTIMATE, labelled as
 *  one everywhere it is shown. */
export const LOCAL_ENGINE_WEIGHTS_MB = 220;

/** Headroom demanded before storage counts as sufficient: the weights plus room
 *  for a cache the browser will not immediately evict. */
export const STORAGE_HEADROOM_MB = LOCAL_ENGINE_WEIGHTS_MB * 2;

/** Minimum device memory (GB) a single-threaded WASM decode is comfortable in. */
export const MIN_DEVICE_MEMORY_GB = 2;

export type SignalWeight =
  /** Without this there is no local engine at all. */
  | "required"
  /** The engine would run, but slowly or unreliably. */
  | "recommended"
  /** Faster if present; the WASM path never needs it. */
  | "optional";

export type ProbeSignal = {
  id: string;
  label: string;
  weight: SignalWeight;
  /** true = present, false = absent, null = this browser will not say. */
  ok: boolean | null;
  /** One sentence a user can act on, or the reason the answer is unknown. */
  detail: string;
};

export type EngineProbeReport = {
  /** True only when every REQUIRED signal is present. An unknown required
   *  signal is not capable — "probably" is not a yes. */
  capable: boolean;
  /** Ids of required/recommended signals this browser does NOT have. */
  missing: string[];
  /** Ids of signals this browser refused to answer. */
  unknown: string[];
  signals: ProbeSignal[];
  /** Caveats worth printing next to the verdict. Never empty in practice. */
  notes: string[];
};

/** The globals the probe reads, injectable so the matrix can be tested without
 *  pretending jsdom is Safari. */
export type ProbeEnv = {
  wasm?: typeof WebAssembly | undefined;
  /** Structural on purpose: the real `Navigator` type does not admit a partial
   *  StorageManager, and a matrix that cannot express "Safari" is not a matrix.
   *  `deviceMemory` and `gpu` are also not in the DOM lib on every target. */
  navigator?: ProbeNavigator;
  crossOriginIsolated?: boolean;
  sharedArrayBuffer?: unknown;
};

export type ProbeNavigator = {
  deviceMemory?: number;
  gpu?: unknown;
  storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> };
};

/**
 * A minimal valid WASM module whose one function body contains a SIMD
 * instruction (`i8x16.splat`). `WebAssembly.validate` returns false where SIMD
 * is unsupported, which is the only reliable way to detect it — there is no
 * feature flag to read.
 *
 * Bytes: magic + version; type section (() -> ()); function section; code
 * section with `i32.const 0; i8x16.splat; drop; end`.
 */
const SIMD_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x1a, 0x0b,
]);

function readEnv(): ProbeEnv {
  const g = globalThis as unknown as {
    WebAssembly?: typeof WebAssembly;
    navigator?: ProbeNavigator;
    crossOriginIsolated?: boolean;
    SharedArrayBuffer?: unknown;
  };
  return {
    wasm: g.WebAssembly,
    navigator: g.navigator,
    crossOriginIsolated: g.crossOriginIsolated,
    sharedArrayBuffer: g.SharedArrayBuffer,
  };
}

const MB = 1024 * 1024;

function mb(bytes: number): string {
  return `${Math.round(bytes / MB).toLocaleString("en-US")} MB`;
}

/**
 * Feature-detect what a local engine would need. Never throws: a probe that
 * fails is a probe that reports "unknown", not one that breaks the page it is
 * decorating.
 */
export async function probeLocalEngine(env: ProbeEnv = readEnv()): Promise<EngineProbeReport> {
  const signals: ProbeSignal[] = [];

  // ── WebAssembly ───────────────────────────────────────────────────────────
  const wasm = env.wasm;
  const hasWasm = typeof wasm?.validate === "function";
  signals.push({
    id: "wasm", label: "WebAssembly", weight: "required",
    ok: hasWasm,
    detail: hasWasm
      ? "the runtime the engine would be compiled to"
      : "no WebAssembly — a local engine is impossible in this browser",
  });

  // ── SIMD ──────────────────────────────────────────────────────────────────
  let simd: boolean | null = null;
  if (hasWasm) {
    try {
      simd = wasm!.validate(SIMD_MODULE);
    } catch {
      // validate() should not throw; if it does, the answer is unknown, not no.
      simd = null;
    }
  } else {
    simd = false;
  }
  signals.push({
    id: "simd", label: "WASM SIMD", weight: "required",
    ok: simd,
    detail: simd === null
      ? "the SIMD probe module could not be validated — treat as unsupported"
      : simd
        ? "vectorised math — without it inference is several times slower than realtime"
        : "no SIMD (Safari before 16.4, older Chromium) — inference would be far slower than realtime",
  });

  // ── threads ───────────────────────────────────────────────────────────────
  const sab = typeof env.sharedArrayBuffer !== "undefined";
  const isolated = env.crossOriginIsolated === true;
  const threads = sab && isolated;
  signals.push({
    id: "threads", label: "WASM threads (cross-origin isolated)", weight: "recommended",
    ok: threads,
    detail: threads
      ? "SharedArrayBuffer is available and this page is cross-origin isolated"
      : !sab
        ? "no SharedArrayBuffer — the engine would run single-threaded"
        : "SharedArrayBuffer exists but this page is not cross-origin isolated: serving it "
          + "would need COOP/COEP headers, which also break third-party embeds",
  });

  // ── WebGPU ────────────────────────────────────────────────────────────────
  // Presence of navigator.gpu only. Deliberately NOT calling requestAdapter():
  // the answer would still not prove the graph runs, and the WASM path never
  // needs it — so an optional signal does not get to do work on page load.
  const nav = env.navigator;
  const gpu = nav ? "gpu" in nav && !!nav.gpu : false;
  signals.push({
    id: "webgpu", label: "WebGPU", weight: "optional",
    ok: gpu,
    detail: gpu
      ? "the API is present (an adapter is not requested here, so this is not proof of a usable GPU)"
      : "no WebGPU — the CPU/WASM path is the one this engine is designed for anyway",
  });

  // ── storage ───────────────────────────────────────────────────────────────
  let storageOk: boolean | null = null;
  let storageDetail =
    "this browser does not expose a storage estimate — the weights may or may not fit";
  const estimate = nav?.storage?.estimate;
  if (typeof estimate === "function") {
    try {
      const { quota, usage } = await estimate.call(nav!.storage);
      if (typeof quota === "number" && quota > 0) {
        const free = quota - (typeof usage === "number" ? usage : 0);
        storageOk = free >= STORAGE_HEADROOM_MB * MB;
        storageDetail = `${mb(free)} of quota free, ${LOCAL_ENGINE_WEIGHTS_MB} MB of weights `
          + "to cache — and the quota is a browser POLICY number, not free disk";
      }
    } catch {
      storageDetail = "the storage estimate failed — treat the available space as unknown";
    }
  }
  signals.push({
    id: "storage", label: "storage for cached weights", weight: "recommended",
    ok: storageOk, detail: storageDetail,
  });

  // ── device memory ─────────────────────────────────────────────────────────
  const dm = typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null;
  signals.push({
    id: "memory", label: "device memory", weight: "recommended",
    ok: dm === null ? null : dm >= MIN_DEVICE_MEMORY_GB,
    detail: dm === null
      ? "navigator.deviceMemory is Chromium-only — absence says nothing about this device"
      : `${dm} GB reported (bucketed and capped at 8 by the API, so 8 means "8 or more")`,
  });

  const capable = signals
    .filter((s) => s.weight === "required")
    .every((s) => s.ok === true);

  return {
    capable,
    missing: signals.filter((s) => s.weight !== "optional" && s.ok === false).map((s) => s.id),
    unknown: signals.filter((s) => s.ok === null).map((s) => s.id),
    signals,
    notes: probeNotes(signals),
  };
}

/** Caveats that belong NEXT TO the verdict, because the verdict is weaker than
 *  it looks. Each one names a browser or an assumption rather than hedging. */
function probeNotes(signals: ProbeSignal[]): string[] {
  const by = (id: string) => signals.find((s) => s.id === id);
  const notes = [
    "This is a capability check only. No model was downloaded and nothing was run —"
    + " the local engine is not shipped yet.",
  ];
  if (by("storage")?.ok === null) {
    notes.push(
      "Safari reports no usable storage estimate and evicts caches on its own schedule,"
      + " so 'enough space' cannot be promised there even when the engine exists.",
    );
  }
  if (by("memory")?.ok === null) {
    notes.push(
      "Firefox and Safari do not expose device memory at all; a passing verdict here"
      + " has not checked RAM.",
    );
  }
  if (by("threads")?.ok === false) {
    notes.push(
      "Single-threaded WASM is the fallback, not a failure — expect slower-than-realtime"
      + " synthesis rather than none.",
    );
  }
  return notes;
}
