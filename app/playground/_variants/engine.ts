"use client";

import { waveHeights, type Voice } from "./shared";

/** Decode a WAV blob and reduce it to N peak bars + true duration. */
export async function computePeaks(blob: Blob, n = 48): Promise<{ peaks: number[]; duration: number }> {
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
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
  } finally {
    void ctx.close();
  }
}

export type SynthResult = {
  mode: "gravitone" | "browser";
  url?: string;
  peaks: number[];
  seconds: number;
  kb: number;
  rtf: number;
};

/**
 * Synthesize `text` with `voice`. Prefers the real Gravitone backend (via the
 * /api/tts server proxy); if it's unreachable, falls back to the browser's
 * speech engine so the playground still speaks.
 */
export async function synthesize(text: string, voice: Voice): Promise<SynthResult> {
  const trimmed = text.trim();
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, voiceId: voice.id }),
    });
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const { peaks, duration } = await computePeaks(blob);
      const hdrSec = Number(res.headers.get("X-Audio-Seconds"));
      const hdrRtf = Number(res.headers.get("X-Realtime-Factor"));
      return {
        mode: "gravitone",
        url,
        peaks,
        seconds: Math.round((hdrSec || duration) * 10) / 10,
        kb: Math.round(blob.size / 1024),
        rtf: hdrRtf || voice.rtf,
      };
    }
  } catch {
    /* fall through to browser speech */
  }
  const seconds = Math.max(1.5, Math.round(trimmed.length * 0.055 * 10) / 10);
  return {
    mode: "browser",
    peaks: waveHeights(trimmed.length * 31 + 7, 48),
    seconds,
    kb: 0,
    rtf: voice.rtf,
  };
}
