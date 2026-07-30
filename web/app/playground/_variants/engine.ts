"use client";

import { apiJson, readDetail, throwDetail } from "@/lib/apiFetch";
import { DEFAULT_OUTPUT_FORMAT, formatMeta, type OutputFormat } from "@/lib/audioFormats";
import {
  crossfadeConcat, encodeWav, fromDecodedAudio, peaksFromPcm, peaksFromSamples, pcmDuration,
  slicePcm, type Pcm,
} from "@/lib/wavEncode";
import {
  scaleSegmentSeconds, segmentRegions, stripTags, waveHeights,
  type Expression, type PerfLine, type Segment, type Take,
} from "./shared";

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
  // The reduction itself lives in lib/wavEncode so a SPLICED take's bars are
  // computed by exactly the same arithmetic as a rendered one's.
  return { peaks: peaksFromSamples(buf.getChannelData(0), n), duration: buf.duration };
}

/**
 * Decode any take/fragment blob into samples on the shared AudioContext.
 *
 * This is where "mp3 takes are decoded and re-mastered as WAV" happens: the
 * decoder does not care what container it was handed, and everything downstream
 * of here is Float32 at the context's rate.
 */
export async function decodePcm(blob: Blob): Promise<Pcm> {
  const ctx = peakContext();
  return fromDecodedAudio(await ctx.decodeAudioData(await blob.arrayBuffer()));
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
  // The filename carries the take's real extension — an mp3 posted as
  // "take.wav" would be a second lie on top of the one the backend rejects.
  fd.append("file", blob, `take.${formatMeta(t.format).ext}`);
  // Remix lineage: /t/[id]'s "open in the rack" leaves the source take id in
  // sessionStorage, so the take rendered from it publishes as that take's CHILD.
  let parentId = "";
  try { parentId = sessionStorage.getItem("gravitone.remix.parent") ?? ""; } catch { /* no storage - publish unlinked */ }
  fd.append("meta", JSON.stringify({
    character_id: t.characterId, character_name: t.characterName,
    text: t.text, seconds: t.seconds, rtf: t.rtf, segments: t.segments,
    ...(parentId ? { parent_id: parentId, derived_from: { kind: "remix" } } : {}),
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
  // How many synth jobs the script became (X-Synth-Segments), or 0 when the
  // backend did not report it (single-segment takes, browser fallback).
  //
  // DELIBERATELY NOT RENDERED: the take card already draws one chip per segment
  // from X-Segments / X-Performance-Report, so the count is on screen as the
  // ribbon's length and a second numeric copy of it would be noise. It is
  // decoded here because the header now survives the proxy at all (it never
  // used to) and because the ribbon is best-effort — a report that fails to
  // decode leaves this as the only evidence the take was multi-segment.
  synthSegments: number;
  // The format this take was rendered as. Drives the download's extension and
  // the code export's `output_format`; wav for the browser fallback, which is
  // spoken locally and has no file at all.
  format: OutputFormat;
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
    ignoredSettings: [], segments: [], synthSegments: 0,
    format: DEFAULT_OUTPUT_FORMAT, fallbackReason: reason,
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
async function gravitoneResult(res: Response, segments: Segment[], seed: number,
                                format: OutputFormat): Promise<SpeakResult> {
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
    synthSegments: Math.max(0, Number(res.headers.get("X-Synth-Segments")) || 0),
    format,
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
                            signal?: AbortSignal,
                            format: OutputFormat = DEFAULT_OUTPUT_FORMAT): Promise<SpeakResult> {
  const trimmed = text.trim();
  let res: Response | null = null;
  let reason: FallbackReason = "unreachable";
  let detail: string | undefined;
  try {
    res = await fetch(`/api/speak?output_format=${encodeURIComponent(format)}`, {
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
      return gravitoneResult(res, decodeSegments(res.headers.get("X-Segments")),
                             trimmed.length * 31 + 7, format);
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
                              signal?: AbortSignal,
                              format: OutputFormat = DEFAULT_OUTPUT_FORMAT): Promise<SpeakResult> {
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
    res = await fetch(`/api/performance?output_format=${encodeURIComponent(format)}`, {
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
      return gravitoneResult(res, decodePerformanceReport(res.headers.get("X-Performance-Report")),
                             seed, format);
    }
    ({ reason, detail } = await triageFailure(res));
  }

  return browserFallback(stripTags(lines.map((l) => l.text).join(" ")), reason, detail);
}

// ── the splice kernel ───────────────────────────────────────────────────────

export type SpliceInput = {
  /** The take being punched. Must carry its audio blob (every gravitone take
   *  does, restored ones included). */
  base: Take;
  /** Which segment of `base.segments` the fragment replaces. */
  regionIndex: number;
  /** The re-rendered region, in whatever format it was rendered as. */
  fragment: Blob;
  /** The fragment's own per-segment report (X-Segments). May be empty. */
  fragmentSegments: Segment[];
};

export type SpliceResult = {
  /** The new master. ALWAYS wav: a spliced mp3 would mean re-encoding a lossy
   *  file every time a word is fixed, and the studio's lossless format is what
   *  the share/review paths accept. */
  blob: Blob;
  /** Decoded duration of the result — the truth, not a sum of reports. */
  seconds: number;
  peaks: number[];
  segments: Segment[];
  /** Where the patched region now sits, so the caller can play just the edit. */
  start: number;
  end: number;
};

/**
 * Replace one segment's audio with a re-rendered fragment.
 *
 * Boundaries come from `segmentRegions`, which snaps them to segment edges —
 * exactly where the engine already cut — and the seams get a short crossfade
 * (lib/wavEncode) so a splice does not click.
 *
 * Returns null on ANY failure, the same degrade as refinePeaks: a browser that
 * cannot decode the take, a fragment that will not decode, a context that was
 * never granted. The caller keeps the original take and offers a full
 * re-render, which is always the escape hatch. Losing the user's take to fix
 * one word would be the worst possible trade.
 */
export async function spliceRegion(input: SpliceInput): Promise<SpliceResult | null> {
  const { base, regionIndex, fragment, fragmentSegments } = input;
  if (!base.blob || regionIndex < 0 || regionIndex >= base.segments.length) return null;
  try {
    const [basePcm, fragPcm] = await Promise.all([decodePcm(base.blob), decodePcm(fragment)]);
    const duration = pcmDuration(basePcm);
    const regions = segmentRegions(base.segments, duration);
    const region = regions[regionIndex];
    if (!region) return null;

    const head = slicePcm(basePcm, 0, region.start);
    const tail = slicePcm(basePcm, region.end, duration);
    const out = crossfadeConcat([head, fragPcm, tail]);
    const fragSeconds = pcmDuration(fragPcm);

    // The replaced segment's Character and source line survive the patch — a
    // punched performance take must stay attributable line by line.
    const carrier = base.segments[regionIndex];
    const replacement: Segment[] = (fragmentSegments.length > 0
      ? scaleSegmentSeconds(fragmentSegments, fragSeconds)
      : [{ ...carrier, seconds: Math.round(fragSeconds * 100) / 100 }]
    ).map((s) => ({ ...s, characterId: s.characterId ?? carrier.characterId, line: s.line ?? carrier.line }));
    const segments = [...base.segments];
    segments.splice(regionIndex, 1, ...replacement);

    return {
      blob: encodeWav(out),
      seconds: Math.round(pcmDuration(out) * 10) / 10,
      peaks: peaksFromPcm(out),
      segments,
      start: pcmDuration(head),
      end: pcmDuration(head) + fragSeconds,
    };
  } catch {
    return null;
  }
}

// ── word timestamps (the studio's own ears) ─────────────────────────────────

export type WordStamp = { text: string; start: number; end: number };

/**
 * Word timings for a take, through the local ASR (`/api/stt` → the service's
 * `/v1/speech-to-text`). Used to narrow a punch-in from a whole segment to the
 * smallest re-renderable span.
 *
 * The route answers 503 with the install hint when faster-whisper weights are
 * absent, which is a legitimate state on a fresh box — the caller reports it and
 * keeps offering segment-level punch-in.
 */
export async function transcribeWords(blob: Blob, format?: OutputFormat,
                                      signal?: AbortSignal): Promise<{ text: string; words: WordStamp[] }> {
  const fd = new FormData();
  fd.append("file", blob, `take.${formatMeta(format).ext}`);
  fd.append("timestamps_granularity", "word");
  const j = await apiJson<{ text?: string; words?: Array<{ text?: string; start?: number; end?: number }> }>(
    "/api/stt", { method: "POST", body: fd, signal }, "could not transcribe this take");
  return {
    text: j.text ?? "",
    words: (j.words ?? [])
      .filter((w) => typeof w.start === "number" && typeof w.end === "number" && !!w.text)
      .map((w) => ({ text: String(w.text), start: w.start as number, end: w.end as number })),
  };
}
