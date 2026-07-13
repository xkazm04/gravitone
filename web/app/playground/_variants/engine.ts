"use client";

import { stripTags, waveHeights, type Expression, type PerfLine, type Segment, type Take } from "./shared";

// One module-level AudioContext shared across every peak computation. Browsers
// cap the number of live AudioContexts (~6), so minting a fresh one per take
// (and closing it) churned toward that ceiling; a single resumable context
// decodes every take. Never closed — it lives for the page's lifetime.
let sharedCtx: AudioContext | null = null;

function peakContext(): AudioContext {
  if (!sharedCtx) {
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new AC();
  }
  // A context can auto-suspend (autoplay policy); resume before decoding.
  if (sharedCtx.state === "suspended") void sharedCtx.resume();
  return sharedCtx;
}

/** Decode a WAV blob and reduce it to N peak bars + true duration. */
export async function computePeaks(blob: Blob, n = 56): Promise<{ peaks: number[]; duration: number }> {
  const ctx = peakContext();
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const data = buf.getChannelData(0);
  const chunk = Math.max(1, Math.floor(data.length / n));
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    let peak = 0;
    const start = i * chunk;
    for (let j = start; j < start + chunk && j < data.length; j++) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    peaks.push(peak);
  }
  const max = Math.max(...peaks, 0.001);
  return { peaks: peaks.map((p) => Math.max(0.06, p / max)), duration: buf.duration };
}

/**
 * Publish a take to the backend as a public Voice Card and return its id.
 * The single upload path shared by "↗ share" and the client-review flow — both
 * turn the take's audio blob into the same multipart POST to /api/takes.
 * Throws for browser-fallback takes (no audio blob to publish).
 */
export async function uploadTake(t: Take): Promise<string> {
  if (!t.url) throw new Error("browser-fallback takes cannot be shared");
  const blob = await (await fetch(t.url)).blob();
  const fd = new FormData();
  fd.append("file", blob, "take.wav");
  fd.append("meta", JSON.stringify({
    character_id: t.characterId, character_name: t.characterName,
    text: t.text, seconds: t.seconds, rtf: t.rtf, segments: t.segments,
  }));
  const r = await fetch("/api/takes", { method: "POST", body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.detail ?? "could not publish the take");
  return j.take_id as string;
}

export type SpeakResult = {
  mode: "gravitone" | "browser";
  url?: string;
  peaks: number[];
  seconds: number;
  kb: number;
  rtf: number;
  // Honest timing: server-side synthesis time and queue wait (0 when the
  // backend did not report them, e.g. the browser fallback).
  synthSeconds: number;
  queueSeconds: number;
  // ElevenLabs settings the backend accepted but could not honestly apply
  // (e.g. similarity_boost, style) — surfaced so the no-op is never silent.
  ignoredSettings: string[];
  segments: Segment[];
};

/**
 * The backend refused with 429 backpressure (queue full). This is NOT a reason
 * to drop to the browser voice — the engine is up and will accept a retry — so
 * it is thrown distinctly instead of collapsing into the fallback path.
 */
export class EngineBusyError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("engine busy — retry in a moment");
    this.name = "EngineBusyError";
    this.retryAfterSec = retryAfterSec;
  }
}

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

function decodeSegments(header: string | null): Segment[] {
  if (!header) return [];
  try {
    return JSON.parse(atob(header)) as Segment[];
  } catch {
    return [];
  }
}

/**
 * Decode the X-Performance-Report header (base64 JSON, one entry per rendered
 * segment) into Segments carrying the speaking Character + source line index,
 * mirroring how X-Segments is decoded for solo takes.
 */
function decodePerformanceReport(header: string | null): Segment[] {
  if (!header) return [];
  try {
    const rows = JSON.parse(atob(header)) as Array<
      Segment & { character_id?: string; line?: number }
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

/** Build a gravitone SpeakResult from a successful audio response. */
async function gravitoneResult(res: Response, segments: Segment[], seed: number): Promise<SpeakResult> {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const hdrSec = Number(res.headers.get("X-Audio-Seconds"));
  const hdrRtf = Number(res.headers.get("X-Realtime-Factor"));
  const hdrSynth = Number(res.headers.get("X-Synth-Seconds"));
  const hdrQueue = Number(res.headers.get("X-Queue-Seconds"));
  // Waveform extraction is best-effort — a decode hiccup on the concatenated
  // multi-segment WAV must NOT drop us to the browser fallback. Keep the real
  // audio; fall back to synthetic bars.
  let peaks = waveHeights(seed, 56);
  let duration = 0;
  try {
    const p = await computePeaks(blob);
    peaks = p.peaks;
    duration = p.duration;
  } catch {
    /* keep the synthetic peaks; audio still plays */
  }
  return {
    mode: "gravitone", url, peaks,
    seconds: Math.round((hdrSec || duration) * 10) / 10,
    kb: Math.round(blob.size / 1024),
    rtf: hdrRtf || 0,
    synthSeconds: Number.isFinite(hdrSynth) ? hdrSynth : 0,
    queueSeconds: Number.isFinite(hdrQueue) ? hdrQueue : 0,
    ignoredSettings: decodeIgnored(res.headers.get("X-Ignored-Settings")),
    segments,
  };
}

/**
 * Speak metatagged text with one Character. Emotions the Character lacks fall
 * back to baseline; the per-segment report says what actually happened.
 * Falls back to browser speech (tags stripped) when the backend is unreachable.
 */
export async function speak(text: string, characterId: string, expr: Expression): Promise<SpeakResult> {
  const trimmed = text.trim();
  let res: Response | null = null;
  try {
    res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        character_id: characterId,
        text: trimmed,
        voice_settings: { temperature: expr.temperature, stability: expr.stability, quality: expr.quality },
      }),
    });
  } catch {
    // Network / proxy-unreachable — the engine is genuinely out of reach, so
    // the browser voice is the honest fallback (handled below).
    res = null;
  }

  if (res) {
    // Backpressure is up-but-busy, not down: surface it distinctly so the UI
    // offers a retry rather than silently substituting the browser voice.
    if (res.status === 429) {
      throw new EngineBusyError(parseRetryAfter(res.headers.get("Retry-After")));
    }
    if (res.ok) {
      return gravitoneResult(res, decodeSegments(res.headers.get("X-Segments")), trimmed.length * 31 + 7);
    }
    // Any other upstream failure (502/503/500) keeps the browser fallback.
  }

  const plain = stripTags(trimmed);
  const seconds = Math.max(1.5, Math.round(plain.length * 0.055 * 10) / 10);
  return {
    mode: "browser", peaks: waveHeights(plain.length * 31 + 7, 56),
    seconds, kb: 0, rtf: 0, synthSeconds: 0, queueSeconds: 0,
    ignoredSettings: [], segments: [],
  };
}

/**
 * Render a multi-character performance script in ONE call: every line's
 * Character speaks its (optionally metatagged) text, Voices switching per
 * character and per emotion. Returns a single concatenated take whose segments
 * carry who spoke what. Falls back to browser speech (whole script, tags
 * stripped) when the backend is unreachable; 429 backpressure throws distinctly.
 */
export async function perform(lines: PerfLine[], expr: Expression): Promise<SpeakResult> {
  const body = {
    lines: lines.map((l) => ({
      character_id: l.character_id,
      text: l.text.trim(),
      voice_settings: { temperature: expr.temperature, stability: expr.stability, quality: expr.quality },
    })),
  };
  let res: Response | null = null;
  try {
    res = await fetch("/api/performance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    res = null;
  }

  if (res) {
    if (res.status === 429) {
      throw new EngineBusyError(parseRetryAfter(res.headers.get("Retry-After")));
    }
    if (res.ok) {
      const seed = lines.reduce((n, l) => n + l.text.length, 0) * 31 + 7;
      return gravitoneResult(res, decodePerformanceReport(res.headers.get("X-Performance-Report")), seed);
    }
  }

  const plain = stripTags(lines.map((l) => l.text).join(" "));
  const seconds = Math.max(1.5, Math.round(plain.length * 0.055 * 10) / 10);
  return {
    mode: "browser", peaks: waveHeights(plain.length * 31 + 7, 56),
    seconds, kb: 0, rtf: 0, synthSeconds: 0, queueSeconds: 0,
    ignoredSettings: [], segments: [],
  };
}
