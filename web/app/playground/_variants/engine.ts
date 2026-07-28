"use client";

import { apiJson, readDetail, throwDetail } from "@/lib/apiFetch";
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

/** Decode a WAV blob and reduce it to N peak bars + true duration. Throws if the
 *  blob cannot be decoded (no AudioContext, malformed WAV) — see refinePeaks. */
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
 * Best-effort real waveform for a take that is ALREADY on screen.
 *
 * Returns null instead of throwing: a decode hiccup on a concatenated
 * multi-segment WAV must never cost the user their take, so the synthetic bars
 * simply stay. This is the same degrade the synthesis path used to do inline —
 * it just no longer happens before the take can be shown.
 */
export async function refinePeaks(blob: Blob): Promise<{ peaks: number[]; duration: number } | null> {
  try {
    return await computePeaks(blob);
  } catch {
    return null;
  }
}

/**
 * Publish a take to the backend as a public Voice Card and return its id.
 * The single upload path shared by "↗ share" and the client-review flow — both
 * turn the take's audio blob into the same multipart POST to /api/takes.
 * Throws for browser-fallback takes (no audio blob to publish).
 */
export async function uploadTake(t: Take): Promise<string> {
  // The take carries its own audio blob (synthesis hands it over, and session
  // restore reads it back out of IndexedDB). Re-fetching t.url — an object URL
  // pointing at a blob we already hold — was a copy of the whole WAV for
  // nothing.
  if (!t.blob) throw new Error("browser-fallback takes cannot be shared");
  const blob = t.blob;
  const fd = new FormData();
  fd.append("file", blob, "take.wav");
  fd.append("meta", JSON.stringify({
    character_id: t.characterId, character_name: t.characterName,
    text: t.text, seconds: t.seconds, rtf: t.rtf, segments: t.segments,
  }));
  // Through the apiFetch contract so the backend's sanitized `detail` (request
  // id included) reaches the caller's banner instead of a generic sentence.
  const j = await apiJson<{ take_id: string }>(
    "/api/takes", { method: "POST", body: fd }, "could not publish the take");
  return j.take_id;
}

/**
 * WHY the browser voice was used. The fallback itself is deliberate (the
 * playground should always produce something), but the three causes are not
 * the same event and the UI must not report them identically:
 *   unreachable — the request never completed (network / proxy down)
 *   draining    — the backend is shutting down; it will be back
 *   failed      — the engine answered with an error (5xx): it IS reachable,
 *                 synthesis is what broke
 * Saying "backend unreachable" for a 500 is the lie this type exists to stop.
 */
export type FallbackReason = "unreachable" | "draining" | "failed";

export type SpeakResult = {
  mode: "gravitone" | "browser";
  url?: string;
  // The synthesized audio itself. It was created by res.blob(), turned into an
  // object URL and then thrown away, so persisting and publishing the take each
  // fetched the object URL to get the same bytes back. Carried instead.
  blob?: Blob;
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
  // Set only when mode === "browser".
  fallbackReason?: FallbackReason;
  // The backend's sanitized `detail` for the failure that caused the fallback.
  // service/errors.py::sanitized_500 writes a request-correlation id into it —
  // throwing that away left every failure reading as one generic sentence and
  // left support with nothing to correlate. Absent for transport failures
  // (there is no response) and for a proxy that answered non-JSON.
  fallbackDetail?: string;
};

/**
 * The backend refused with 429 backpressure (queue full). This is NOT a reason
 * to drop to the browser voice — the engine is up and will accept a retry — so
 * it is thrown distinctly instead of collapsing into the fallback path.
 */
/** True for a cancel triggered through an AbortSignal (fetch rejects with a
 *  DOMException named "AbortError"; jsdom/node shapes vary, so check both). */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException
    ? e.name === "AbortError"
    : (e as { name?: string } | null)?.name === "AbortError";
}

/** The browser-speech take, tagged with WHY we fell back to it. */
function browserFallback(plain: string, reason: FallbackReason, detail?: string): SpeakResult {
  const seconds = Math.max(1.5, Math.round(plain.length * 0.055 * 10) / 10);
  return {
    mode: "browser", peaks: waveHeights(plain.length * 31 + 7, 56),
    seconds, kb: 0, rtf: 0, synthSeconds: 0, queueSeconds: 0,
    ignoredSettings: [], segments: [], fallbackReason: reason,
    fallbackDetail: detail,
  };
}

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

/**
 * Triage a non-OK synthesis response — the ONE place speak() and perform()
 * decide "fall back" vs "tell the user". Everything goes through the apiFetch
 * contract (`readDetail`/`throwDetail`) so the backend's user-showable `detail`
 * — request id included — survives instead of being replaced by a generic
 * sentence.
 *
 * Throws (no browser take at all) for the two statuses the fallback would lie
 * about:
 *   429 — the engine is up and will accept a retry (EngineBusyError)
 *   404 — the Character is GONE. Speaking the line in a browser voice hid a
 *         roster that no longer matches the backend; the user must be told.
 * Everything else keeps the deliberate browser-voice fallback and returns the
 * reason + detail to report alongside it.
 */
async function triageFailure(res: Response): Promise<{ reason: FallbackReason; detail?: string }> {
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
  return {
    reason: res.status === 503 ? (unreachable ? "unreachable" : "draining") : "failed",
    detail,
  };
}

/** Build a gravitone SpeakResult from a successful audio response. */
async function gravitoneResult(res: Response, segments: Segment[], seed: number): Promise<SpeakResult> {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const hdrSec = Number(res.headers.get("X-Audio-Seconds"));
  const hdrRtf = Number(res.headers.get("X-Realtime-Factor"));
  const hdrSynth = Number(res.headers.get("X-Synth-Seconds"));
  const hdrQueue = Number(res.headers.get("X-Queue-Seconds"));
  // The take ships with synthetic bars and the caller refines them (see
  // refinePeaks) once it is on screen. Decoding the whole WAV here delayed the
  // take's APPEARANCE by a full main-thread decode for a decoration; the
  // degrade-to-synthetic-bars path is now simply "the refinement never landed".
  return {
    mode: "gravitone", url, blob, peaks: waveHeights(seed, 56),
    seconds: Math.round((hdrSec || 0) * 10) / 10,
    kb: Math.round(blob.size / 1024),
    rtf: hdrRtf || 0,
    synthSeconds: Number.isFinite(hdrSynth) ? hdrSynth : 0,
    queueSeconds: Number.isFinite(hdrQueue) ? hdrQueue : 0,
    ignoredSettings: decodeIgnored(res.headers.get("X-Ignored-Settings")),
    segments,
  };
}

/**
 * Speak metatagged text with one Character. Emotions the Character lacks are
 * substituted with the nearest recorded emotion, then baseline (see
 * service/emotions.py::resolve); the per-segment report says what actually
 * happened. Falls back to browser speech (tags stripped) when synthesis fails;
 * 429 backpressure and a 404 unknown Character throw instead.
 */
export async function speak(text: string, characterId: string, expr: Expression,
                            signal?: AbortSignal): Promise<SpeakResult> {
  const trimmed = text.trim();
  let res: Response | null = null;
  let reason: FallbackReason = "unreachable";
  let detail: string | undefined;
  try {
    res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        character_id: characterId,
        text: trimmed,
        voice_settings: { temperature: expr.temperature, stability: expr.stability, quality: expr.quality },
      }),
      signal,
    });
  } catch (e) {
    // A user-initiated cancel is NOT a backend failure — propagate it so the
    // caller can just drop the request instead of fabricating a browser take.
    if (isAbort(e)) throw e;
    // Network / proxy-unreachable — the engine is genuinely out of reach, so
    // the browser voice is the honest fallback (handled below).
    res = null;
  }

  if (res) {
    if (res.ok) {
      return gravitoneResult(res, decodeSegments(res.headers.get("X-Segments")), trimmed.length * 31 + 7);
    }
    // Backpressure (429) and a gone Character (404) throw out of here; anything
    // else still falls back to the browser voice, carrying WHAT the backend
    // said so the user gets more than "something went wrong".
    ({ reason, detail } = await triageFailure(res));
  }

  return browserFallback(stripTags(trimmed), reason, detail);
}

/**
 * Render a multi-character performance script in ONE call: every line's
 * Character speaks its (optionally metatagged) text, Voices switching per
 * character and per emotion. Returns a single concatenated take whose segments
 * carry who spoke what. Falls back to browser speech (whole script, tags
 * stripped) when synthesis fails; 429 backpressure and a 404 unknown Character
 * throw distinctly (see triageFailure).
 */
export async function perform(lines: PerfLine[], expr: Expression,
                              signal?: AbortSignal): Promise<SpeakResult> {
  const body = {
    lines: lines.map((l) => ({
      character_id: l.character_id,
      text: l.text.trim(),
      voice_settings: { temperature: expr.temperature, stability: expr.stability, quality: expr.quality },
    })),
  };
  let res: Response | null = null;
  let reason: FallbackReason = "unreachable";
  let detail: string | undefined;
  try {
    res = await fetch("/api/performance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (isAbort(e)) throw e;  // user cancelled — not a backend failure
    res = null;
  }

  if (res) {
    if (res.ok) {
      const seed = lines.reduce((n, l) => n + l.text.length, 0) * 31 + 7;
      return gravitoneResult(res, decodePerformanceReport(res.headers.get("X-Performance-Report")), seed);
    }
    ({ reason, detail } = await triageFailure(res));
  }

  return browserFallback(stripTags(lines.map((l) => l.text).join(" ")), reason, detail);
}
