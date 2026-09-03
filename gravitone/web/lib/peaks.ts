"use client";

// Decoding audio in the browser: the one shared AudioContext, and the two
// things every surface asks it for — peak bars, and raw samples.
//
// This used to live in the playground's engine, which is where the STUDIO
// needs it. The public share page needs it too (it draws 64 bars of the take
// it is showing), and importing it from `app/playground/_variants/engine`
// dragged the whole studio into a stranger's page load: the engine seam, the
// api client, the wav splice kernel, the playground's own take model — none of
// which a share page can use. The arithmetic already lived in lib/wavEncode;
// only the browser half was stranded. Now both sides import the same module and
// nobody duplicates a decode.

import { fromDecodedAudio, peaksFromSamples, type Pcm } from "./wavEncode";

// One module-level AudioContext shared across every peak computation. Browsers
// cap the number of live AudioContexts (~6), so minting a fresh one per take
// (and closing it) churned toward that ceiling; a single resumable context
// decodes every take. Never closed — it lives for the page's lifetime.
let sharedCtx: AudioContext | null = null;

export function peakContext(): AudioContext {
  if (!sharedCtx) {
    const AC: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
