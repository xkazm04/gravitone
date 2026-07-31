// The speech-engine seam — ONE typed boundary between "the studio wants audio"
// and "something synthesized it".
//
// Today there is exactly one implementation: ServerEngine, which is the
// /api/speak + /api/performance + /api/tts fetch logic lifted verbatim out of
// app/playground/_variants/engine.ts. Nothing about the request path changed;
// what changed is that the callers now name WHAT they want (a solo take, a
// performance, a punch-in fragment, a cloned-voice line) instead of hand-rolling
// a fetch each.
//
// WHY this exists before there is a second engine: the in-browser engine
// (WASM/SIMD + an exported ONNX graph) is a quarters-scale port, and the honest
// difference between "a port" and "a rewrite" is whether the call sites already
// speak to an interface. They now do. A LocalEngine implementing
// SpeechEngineClient plugs in at `registerEngine` and every existing screen
// keeps working.
//
// WHAT IS NOT HERE, deliberately: no model download, no ONNX runtime, no worker,
// no local inference of any kind. `lib/engineProbe.ts` answers only whether a
// browser COULD host one. Anything on /benchmarks that reads otherwise is a bug.

import { readDetail, throwDetail } from "@/lib/apiFetch";
import { DEFAULT_OUTPUT_FORMAT, type OutputFormat } from "@/lib/audioFormats";

// ── the wire shapes ─────────────────────────────────────────────────────────

/** The three expression knobs the service accepts (`voice_settings`). Declared
 *  here rather than imported from the playground so the seam has no dependency
 *  on the screen that happens to be its biggest caller; the playground's
 *  `Expression` is structurally this type. */
export type VoiceSettings = {
  temperature: number;
  stability: number;
  quality: number;
};

/** One directed line of a multi-character performance (wire spelling). */
export type SynthLine = { character_id: string; text: string };

/**
 * One rendered segment as the service reports it (X-Segments /
 * X-Performance-Report). Structurally identical to the playground's `Segment` —
 * the assignment in engine.ts is the compile-time proof that they have not
 * drifted.
 */
export type SynthSegment = {
  text: string;
  requested: string;
  used: string;
  fallback: boolean;
  voice_id: string;
  seconds: number;
  /** Performance takes only: who spoke it, and its source line index. */
  characterId?: string;
  line?: number;
};

/**
 * What an engine is being asked to synthesize.
 *
 * Three kinds cover every call the studio makes today:
 *   solo        — one Character speaks metatagged text (POST /api/speak)
 *   performance — a multi-character script rendered in ONE call
 *   voice       — a line spoken by a raw voice id (the hero demo)
 *
 * The PUNCH-IN FRAGMENT is deliberately not a fourth kind: a fragment re-render
 * is byte-for-byte the same request as a solo one, pinned to `wav_24000`
 * because `spliceRegion` masters wav. Inventing a discriminant that changed
 * nothing on the wire would be a label pretending to be a code path — the
 * conformance suite exercises the fragment call instead (same shape, wav,
 * abortable, per-segment report consumed by the splice).
 */
export type SynthesisRequest =
  | {
      kind: "solo";
      /** Metatagged text. Callers trim before calling; the seam does not edit it. */
      text: string;
      characterId: string;
      settings: VoiceSettings;
      format?: OutputFormat;
      signal?: AbortSignal;
    }
  | {
      kind: "performance";
      lines: SynthLine[];
      settings: VoiceSettings;
      format?: OutputFormat;
      signal?: AbortSignal;
    }
  | {
      /** A line spoken by a VOICE id rather than a roster Character — the hero
       *  demo's cloned throwaway voice (POST /api/tts). No emotion addressing,
       *  no per-segment report, wav only: that is the endpoint's real shape. */
      kind: "voice";
      text: string;
      voiceId: string;
      signal?: AbortSignal;
    };

export type SynthesisKind = SynthesisRequest["kind"];

/**
 * Synthesized audio plus everything the engine honestly measured about it.
 *
 * Note what is NOT here: waveform bars. The playground's bars are a synthetic
 * decoration refined from the real samples once the take is on screen (see
 * engine.ts::refinePeaks) and the hero demo draws none at all — so they are a
 * caller's concern, not an engine's. An engine reports only what it knows.
 */
export type TakeAudio = {
  /** The audio itself. Callers persist and publish THIS, never a re-fetch. */
  blob: Blob;
  /** An object URL over `blob`, minted once. The caller owns revoking it. */
  url: string;
  /** X-Audio-Seconds, rounded to a tenth (0 when the engine did not report it). */
  seconds: number;
  kb: number;
  rtf: number;
  synthSeconds: number;
  queueSeconds: number;
  /** Settings the engine accepted but could not honestly apply. */
  ignoredSettings: string[];
  segments: SynthSegment[];
  /** How many synth jobs the text became (X-Synth-Segments), 0 when unreported. */
  synthSegments: number;
  format: OutputFormat;
};

/** What an engine can actually do — read by UI that must not promise more. */
export type EngineCaps = {
  id: "server" | "local";
  /** Shown to users. Must describe where the audio is made, honestly. */
  label: string;
  kinds: readonly SynthesisKind[];
  formats: readonly OutputFormat[];
  /** True only if the audio never leaves the device. */
  onDevice: boolean;
  /** True if a reachable backend is required for any synthesis at all. */
  requiresBackend: boolean;
  /** True if audio arrives incrementally. Neither engine streams today. */
  streaming: boolean;
};

export interface SpeechEngineClient {
  synthesize(req: SynthesisRequest): Promise<TakeAudio>;
  capabilities(): EngineCaps;
}

// ── failure vocabulary ──────────────────────────────────────────────────────

/**
 * WHY synthesis did not happen, for the cases where a caller may legitimately
 * degrade (the playground speaks the line in a browser voice instead):
 *   unreachable — the request never completed (network / proxy down)
 *   draining    — the backend is shutting down; it will be back
 *   failed      — the engine answered with an error (5xx): it IS reachable,
 *                 synthesis is what broke
 * Saying "backend unreachable" for a 500 is the lie this type exists to stop.
 */
export type FallbackReason = "unreachable" | "draining" | "failed";

/**
 * The engine could not produce audio, and the caller may degrade.
 *
 * Deliberately an Error rather than a result union: the two failures a caller
 * must NOT paper over (backpressure, a gone Character) already throw, and one
 * `catch` that branches on type keeps them impossible to forget.
 */
export class EngineDegraded extends Error {
  readonly reason: FallbackReason;
  /** The backend's sanitized `detail` (request-correlation id included).
   *  Absent for transport failures — there is no response to read. */
  readonly detail?: string;
  constructor(reason: FallbackReason, detail?: string) {
    super(detail ?? DEGRADED_MESSAGE[reason]);
    this.name = "EngineDegraded";
    this.reason = reason;
    this.detail = detail;
  }
}

const DEGRADED_MESSAGE: Record<FallbackReason, string> = {
  unreachable: "Gravitone backend unreachable",
  draining: "the engine is restarting — try again in a moment",
  failed: "synthesis failed",
};

/**
 * The backend refused with 429 backpressure (queue full). NOT a reason to drop
 * to another voice — the engine is up and will accept a retry — so it is thrown
 * distinctly instead of collapsing into a degrade.
 */
export class EngineBusyError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("engine busy — retry in a moment");
    this.name = "EngineBusyError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** True for a cancel triggered through an AbortSignal (fetch rejects with a
 *  DOMException named "AbortError"; jsdom/node shapes vary, so check both). */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException
    ? e.name === "AbortError"
    : (e as { name?: string } | null)?.name === "AbortError";
}

// ── header decoding (unchanged arithmetic, moved) ───────────────────────────

/** Parse a Retry-After header (delta-seconds form) into a number, default 1. */
function parseRetryAfter(header: string | null): number {
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 1;
}

/** Split an X-Ignored-Settings CSV header into its setting names. */
function decodeIgnored(header: string | null): string[] {
  if (!header) return [];
  return header.split(",").map((s) => s.trim()).filter(Boolean);
}

function decodeSegments(header: string | null): SynthSegment[] {
  if (!header) return [];
  try {
    return JSON.parse(atob(header)) as SynthSegment[];
  } catch {
    return [];
  }
}

/**
 * Decode the X-Performance-Report header (base64 JSON, one entry per rendered
 * segment) into segments carrying the speaking Character + source line index,
 * mirroring how X-Segments is decoded for solo takes.
 */
function decodePerformanceReport(header: string | null): SynthSegment[] {
  if (!header) return [];
  try {
    const rows = JSON.parse(atob(header)) as Array<
      SynthSegment & { character_id?: string; line?: number }
    >;
    return rows.map((r) => ({
      text: r.text, requested: r.requested, used: r.used, fallback: r.fallback,
      voice_id: r.voice_id, seconds: r.seconds,
      characterId: r.character_id, line: r.line,
    }));
  } catch {
    return [];
  }
}

/**
 * Triage a non-OK synthesis response — the ONE place the seam decides "the
 * caller may degrade" vs "tell the user". Everything goes through the apiFetch
 * contract (`readDetail`/`throwDetail`) so the backend's user-showable `detail`
 * — request id included — survives instead of being replaced by a generic
 * sentence.
 *
 * Throws for the two statuses a degrade would lie about:
 *   429 — the engine is up and will accept a retry (EngineBusyError)
 *   404 — the Character is GONE. Speaking the line in another voice hid a
 *         roster that no longer matches the backend; the user must be told.
 */
async function throwForStatus(res: Response): Promise<never> {
  if (res.status === 429) {
    throw new EngineBusyError(parseRetryAfter(res.headers.get("Retry-After")));
  }
  if (res.status === 404) {
    await throwDetail(res, "that Character no longer exists on the backend");
  }
  const detail = await readDetail(res);
  // A 503 is two different events: the studio's own proxy answers "backend
  // unreachable" when it cannot reach the engine at all, while the engine
  // itself answers 503 only while draining. Read them apart instead of
  // reporting a dead backend as "restarting".
  const unreachable = res.status === 503 && detail?.includes("unreachable");
  throw new EngineDegraded(
    res.status === 503 ? (unreachable ? "unreachable" : "draining") : "failed",
    detail,
  );
}

/** Build a TakeAudio from a successful audio response. */
async function readAudio(res: Response, segments: SynthSegment[],
                         format: OutputFormat): Promise<TakeAudio> {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const hdrSec = Number(res.headers.get("X-Audio-Seconds"));
  const hdrRtf = Number(res.headers.get("X-Realtime-Factor"));
  const hdrSynth = Number(res.headers.get("X-Synth-Seconds"));
  const hdrQueue = Number(res.headers.get("X-Queue-Seconds"));
  return {
    blob, url,
    seconds: Math.round((hdrSec || 0) * 10) / 10,
    kb: Math.round(blob.size / 1024),
    rtf: hdrRtf || 0,
    synthSeconds: Number.isFinite(hdrSynth) ? hdrSynth : 0,
    queueSeconds: Number.isFinite(hdrQueue) ? hdrQueue : 0,
    ignoredSettings: decodeIgnored(res.headers.get("X-Ignored-Settings")),
    segments,
    synthSegments: Math.max(0, Number(res.headers.get("X-Synth-Segments")) || 0),
    format,
  };
}

// ── the server engine ───────────────────────────────────────────────────────

type Wire = { url: string; body: BodyInit; json: boolean; signal?: AbortSignal };

/** Project the settings explicitly: the wire carries the three knobs the
 *  service accepts and nothing a caller happened to have on the object. */
function wireSettings(s: VoiceSettings) {
  return { temperature: s.temperature, stability: s.stability, quality: s.quality };
}

/** Turn a request into the exact fetch the studio's proxy routes expect. */
function wireFor(req: SynthesisRequest, format: OutputFormat): Wire {
  if (req.kind === "voice") {
    return {
      url: "/api/tts",
      body: JSON.stringify({ text: req.text, voiceId: req.voiceId }),
      json: true, signal: req.signal,
    };
  }
  if (req.kind === "performance") {
    return {
      url: `/api/performance?output_format=${encodeURIComponent(format)}`,
      body: JSON.stringify({
        lines: req.lines.map((l) => ({
          character_id: l.character_id,
          text: l.text.trim(),
          voice_settings: wireSettings(req.settings),
        })),
      }),
      json: true, signal: req.signal,
    };
  }
  return {
    url: `/api/speak?output_format=${encodeURIComponent(format)}`,
    body: JSON.stringify({
      character_id: req.characterId,
      text: req.text,
      voice_settings: wireSettings(req.settings),
    }),
    json: true, signal: req.signal,
  };
}

/**
 * The only real engine: every audible byte is produced by a server round-trip
 * through the studio's own /api proxies.
 */
export class ServerEngine implements SpeechEngineClient {
  capabilities(): EngineCaps {
    return {
      id: "server",
      label: "server engine (this deployment's CPU)",
      kinds: ["solo", "performance", "voice"],
      formats: ["wav_24000", "mp3_24000_128"],
      onDevice: false,
      requiresBackend: true,
      streaming: false,
    };
  }

  async synthesize(req: SynthesisRequest): Promise<TakeAudio> {
    // /api/tts has no output_format grammar at all — it answers wav. Claiming
    // anything else on that path would be a format the file does not have.
    const format = req.kind === "voice"
      ? DEFAULT_OUTPUT_FORMAT
      : req.format ?? DEFAULT_OUTPUT_FORMAT;
    const wire = wireFor(req, format);

    let res: Response;
    try {
      res = await fetch(wire.url, {
        method: "POST",
        ...(wire.json ? { headers: { "Content-Type": "application/json" } } : {}),
        body: wire.body,
        signal: wire.signal,
      });
    } catch (e) {
      // A user-initiated cancel is NOT a backend failure — propagate it so the
      // caller can drop the request instead of degrading to a fake take.
      if (isAbort(e)) throw e;
      // Network / proxy-unreachable: the engine is genuinely out of reach, and
      // there is no response to read a detail out of.
      throw new EngineDegraded("unreachable");
    }

    if (!res.ok) await throwForStatus(res);

    const segments = req.kind === "performance"
      ? decodePerformanceReport(res.headers.get("X-Performance-Report"))
      : decodeSegments(res.headers.get("X-Segments"));
    return readAudio(res, segments, format);
  }
}

// ── the registry (where a LocalEngine plugs in) ─────────────────────────────

let current: SpeechEngineClient | null = null;

/**
 * The engine the studio should use right now.
 *
 * Always the server engine today, and that is the honest answer — there is no
 * local engine to choose. When one exists it will be registered here after its
 * probe passes AND its weights are resident, never optimistically: an engine
 * that might not be able to speak is worse than one that always can.
 */
export function getEngine(): SpeechEngineClient {
  if (!current) current = new ServerEngine();
  return current;
}

/** Install an engine (the future LocalEngine's entry point). Pass null to fall
 *  back to the server engine — which is also how tests reset the registry. */
export function registerEngine(engine: SpeechEngineClient | null): void {
  current = engine;
}
