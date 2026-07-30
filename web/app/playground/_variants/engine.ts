"use client";

import { apiJson } from "@/lib/apiFetch";
import { DEFAULT_OUTPUT_FORMAT, formatMeta, type OutputFormat } from "@/lib/audioFormats";
import {
  EngineDegraded, getEngine,
  type FallbackReason, type TakeAudio,
} from "@/lib/engineSeam";
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

// WHY the browser voice was used — "unreachable" / "draining" / "failed". The
// vocabulary now belongs to the engine seam (lib/engineSeam), because deciding
// which of the three happened is the ENGINE's knowledge; deciding to speak the
// line in a browser voice anyway is the PLAYGROUND's policy, and that policy
// still lives here. Re-exported so every existing importer of "./engine" is
// unchanged.
export { EngineBusyError, isAbort, type FallbackReason } from "@/lib/engineSeam";

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

/**
 * Dress an engine's TakeAudio as a playground take.
 *
 * The take ships with SYNTHETIC bars and the caller refines them (see
 * refinePeaks) once it is on screen — decoding the whole WAV before returning
 * delayed the take's APPEARANCE by a full main-thread decode for a decoration.
 * Bars are the reason this wrapper exists at all: they are a screen's idea, not
 * an engine's, so no engine is asked to invent them.
 */
function takeFrom(audio: TakeAudio, seed: number): SpeakResult {
  // The assignment of audio.segments into Segment[] is the compile-time proof
  // that the seam's wire shape and the playground's Segment have not drifted.
  const segments: Segment[] = audio.segments;
  return {
    mode: "gravitone", url: audio.url, blob: audio.blob, peaks: waveHeights(seed, 56),
    seconds: audio.seconds, kb: audio.kb, rtf: audio.rtf,
    synthSeconds: audio.synthSeconds, queueSeconds: audio.queueSeconds,
    ignoredSettings: audio.ignoredSettings, segments,
    synthSegments: audio.synthSegments, format: audio.format,
  };
}

/**
 * Speak metatagged text with one Character. Emotions the Character lacks are
 * substituted with the nearest recorded emotion, then baseline (see
 * service/emotions.py::resolve); the per-segment report says what actually
 * happened. Falls back to browser speech (tags stripped) when synthesis fails;
 * 429 backpressure and a 404 unknown Character throw instead.
 *
 * The request itself is the engine's job now (lib/engineSeam). What stays here
 * is the DECISION to speak the line in a browser voice anyway — a playground
 * policy that no engine should be allowed to make on the studio's behalf.
 */
export async function speak(text: string, characterId: string, expr: Expression,
                            signal?: AbortSignal,
                            format: OutputFormat = DEFAULT_OUTPUT_FORMAT): Promise<SpeakResult> {
  const trimmed = text.trim();
  try {
    const audio = await getEngine().synthesize({
      kind: "solo", text: trimmed, characterId, settings: expr, format, signal,
    });
    return takeFrom(audio, trimmed.length * 31 + 7);
  } catch (e) {
    // Backpressure (429), a gone Character (404) and a user cancel all throw
    // past this point; only a degradable failure earns the browser voice, and
    // it carries WHAT the backend said so the user gets more than "something
    // went wrong".
    if (e instanceof EngineDegraded) {
      return browserFallback(stripTags(trimmed), e.reason, e.detail);
    }
    throw e;
  }
}

/**
 * Render a multi-character performance script in ONE call: every line's
 * Character speaks its (optionally metatagged) text, Voices switching per
 * character and per emotion. Returns a single concatenated take whose segments
 * carry who spoke what. Falls back to browser speech (whole script, tags
 * stripped) when synthesis fails; 429 backpressure and a 404 unknown Character
 * throw distinctly (see lib/engineSeam).
 */
export async function perform(lines: PerfLine[], expr: Expression,
                              signal?: AbortSignal,
                              format: OutputFormat = DEFAULT_OUTPUT_FORMAT): Promise<SpeakResult> {
  try {
    const audio = await getEngine().synthesize({
      kind: "performance", lines, settings: expr, format, signal,
    });
    return takeFrom(audio, lines.reduce((n, l) => n + l.text.length, 0) * 31 + 7);
  } catch (e) {
    if (e instanceof EngineDegraded) {
      return browserFallback(stripTags(lines.map((l) => l.text).join(" ")), e.reason, e.detail);
    }
    throw e;
  }
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
