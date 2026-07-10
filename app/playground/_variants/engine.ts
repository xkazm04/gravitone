"use client";

import { stripTags, waveHeights, type Expression, type Segment } from "./shared";

/** Decode a WAV blob and reduce it to N peak bars + true duration. */
export async function computePeaks(blob: Blob, n = 56): Promise<{ peaks: number[]; duration: number }> {
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

export type SpeakResult = {
  mode: "gravitone" | "browser";
  url?: string;
  peaks: number[];
  seconds: number;
  kb: number;
  rtf: number;
  segments: Segment[];
};

function decodeSegments(header: string | null): Segment[] {
  if (!header) return [];
  try {
    return JSON.parse(atob(header)) as Segment[];
  } catch {
    return [];
  }
}

/**
 * Speak metatagged text with one Character. Emotions the Character lacks fall
 * back to baseline; the per-segment report says what actually happened.
 * Falls back to browser speech (tags stripped) when the backend is unreachable.
 */
export async function speak(text: string, characterId: string, expr: Expression): Promise<SpeakResult> {
  const trimmed = text.trim();
  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        character_id: characterId,
        text: trimmed,
        voice_settings: { temperature: expr.temperature, stability: expr.stability, quality: expr.quality },
      }),
    });
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const hdrSec = Number(res.headers.get("X-Audio-Seconds"));
      const hdrRtf = Number(res.headers.get("X-Realtime-Factor"));
      // Waveform extraction is best-effort — a decode hiccup on the concatenated
      // multi-segment WAV must NOT drop us to the browser fallback (that was the
      // "composition produces no audio" bug). Keep the real audio; fake the bars.
      let peaks = waveHeights(trimmed.length * 31 + 7, 56);
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
        segments: decodeSegments(res.headers.get("X-Segments")),
      };
    }
  } catch {
    /* fall through */
  }
  const plain = stripTags(trimmed);
  const seconds = Math.max(1.5, Math.round(plain.length * 0.055 * 10) / 10);
  return {
    mode: "browser", peaks: waveHeights(plain.length * 31 + 7, 56),
    seconds, kb: 0, rtf: 0, segments: [],
  };
}
