"use client";

// Voice Card — the shareable, emotion-synced player. As playback crosses each
// [emotion] segment, the active glyph swaps and the card's glow shifts to
// that emotion's hue; the segment ribbon tracks progress. `compact` renders
// the embeddable variant (no text block, tighter chrome).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import EmotionArt from "@/components/ui/EmotionArt";
import { emotionMeta } from "@/lib/emotions";
import { computePeaks } from "@/app/playground/_variants/engine";

export type SharedTake = {
  id: string;
  character_id: string;
  character_name: string;
  text: string;
  seconds: number;
  rtf: number;
  segments: { text: string; requested: string; used: string; fallback: boolean; seconds: number }[];
  created: string;
};

export default function TakeCard({ take, compact = false }: { take: SharedTake; compact?: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [copied, setCopied] = useState<"link" | "embed" | null>(null);

  // Cumulative segment boundaries (seconds) → active segment during playback.
  const bounds = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const s of take.segments) { acc += s.seconds; out.push(acc); }
    return out;
  }, [take.segments]);
  const duration = bounds[bounds.length - 1] || take.seconds || 1;
  const activeIdx = useMemo(() => {
    const t = progress * duration;
    const i = bounds.findIndex((b) => t < b);
    return i === -1 ? take.segments.length - 1 : i;
  }, [progress, duration, bounds, take.segments.length]);
  const active = take.segments[Math.max(0, activeIdx)] ?? { used: "baseline" };
  const meta = emotionMeta(active.used);

  // Load audio once; peaks for the waveform come from the decoded wav.
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    (async () => {
      try {
        const r = await fetch(`/api/takes/${take.id}/audio`);
        if (!r.ok) return;
        const blob = await r.blob();
        url = URL.createObjectURL(blob);
        if (!alive) return;
        const a = new Audio(url);
        a.ontimeupdate = () => setProgress(a.duration ? a.currentTime / a.duration : 0);
        a.onended = () => { setPlaying(false); setProgress(0); };
        audioRef.current = a;
        try {
          const { peaks: p } = await computePeaks(blob, compact ? 40 : 64);
          if (alive) setPeaks(p);
        } catch { /* waveform is decoration */ }
      } catch { /* audio missing — card still renders */ }
    })();
    return () => {
      alive = false;
      audioRef.current?.pause();
      if (url) URL.revokeObjectURL(url);
    };
  }, [take.id, compact]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else { void a.play(); setPlaying(true); }
  }, [playing]);

  const copy = useCallback(async (what: "link" | "embed") => {
    const link = `${window.location.origin}/t/${take.id}`;
    const text = what === "link" ? link
      : `<iframe src="${link}/embed" width="480" height="220" frameborder="0" title="Gravitone voice card"></iframe>`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* ignore */ }
  }, [take.id]);

  return (
    <div
      className="glass-panel rounded-3xl p-6 transition-shadow duration-700"
      style={{ boxShadow: playing ? `0 0 60px hsl(${meta.hue} 85% 60% / .25)` : undefined }}
    >
      <div className="flex items-center justify-between">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest" style={{ color: `hsl(${meta.hue} 85% 70%)` }}>
          {playing ? `● ${meta.label.toLowerCase()}` : "voice card"}
        </span>
        <span className="font-jetbrains text-[11px] text-white/55">{take.seconds}s · 24kHz · cpu</span>
      </div>

      <div className="mt-4 flex items-center gap-4">
        {/* the glyph IS the playhead: it morphs with the active segment */}
        <button onClick={toggle} aria-label={playing ? "Pause" : "Play"}
          className="group relative grid h-20 w-20 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-2xl border bg-black/50 transition"
          style={{ borderColor: `hsl(${meta.hue} 85% 60% / ${playing ? 0.7 : 0.3})` }}>
          <span aria-hidden className="pointer-events-none absolute inset-0 transition-opacity duration-500"
            style={{ opacity: playing ? 1 : 0, boxShadow: `inset 0 0 30px hsl(${meta.hue} 90% 60% / .4)` }} />
          <EmotionArt key={active.used} emotion={active.used} size={72} dim={!playing} />
          <span className="absolute bottom-1 right-1 grid h-6 w-6 place-items-center rounded-full bg-cyan-300 text-[10px] text-slate-950">
            {playing ? "⏸" : "▶"}
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="font-instrument text-xl text-white">{take.character_name}</div>
          {/* waveform with progress */}
          <div className="mt-2 flex h-10 items-end gap-[2px]" aria-hidden>
            {(peaks.length ? peaks : Array.from({ length: compact ? 40 : 64 }, () => 0.3)).map((h, i, arr) => (
              <span key={i}
                className={`w-[3px] shrink-0 rounded-full transition-colors duration-100 ${i / arr.length <= progress && playing ? "" : "bg-white/20"}`}
                style={{
                  height: `${Math.max(8, Math.round(h * 100))}%`,
                  background: i / arr.length <= progress && playing ? `hsl(${meta.hue} 85% 65%)` : undefined,
                }} />
            ))}
          </div>
        </div>
      </div>

      {/* emotion ribbon — the differentiator on display */}
      {take.segments.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {take.segments.map((s, i) => {
            const m = emotionMeta(s.used);
            const isActive = playing && i === activeIdx;
            return (
              <span key={i} title={s.text}
                className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition"
                style={{
                  borderColor: isActive ? `hsl(${m.hue} 85% 60% / .6)` : "rgba(255,255,255,0.1)",
                  background: isActive ? `hsl(${m.hue} 85% 60% / .12)` : "rgba(255,255,255,0.04)",
                  color: isActive ? `hsl(${m.hue} 85% 78%)` : "rgba(255,255,255,0.7)",
                }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${m.hue} 80% 62%)` }} />
                {s.used}<span className="opacity-60">{s.seconds}s</span>
              </span>
            );
          })}
        </div>
      )}

      {!compact && <p className="mt-4 text-[15px] leading-relaxed text-white/80">{take.text}</p>}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-4">
        <Link href="/" className="font-jetbrains text-[11px] uppercase tracking-widest text-white/50 transition hover:text-cyan-200">
          made with <span className="font-instrument text-[13px] normal-case tracking-normal text-white/80">Gravitone</span>
        </Link>
        {compact ? (
          <a href={`/t/${take.id}`} target="_blank" rel="noreferrer"
            className="font-jetbrains text-[11px] text-cyan-300/80 transition hover:text-cyan-200">open ↗</a>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => void copy("link")}
              className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/85 transition hover:bg-white/5">
              {copied === "link" ? "✓ copied" : "copy link"}
            </button>
            <button onClick={() => void copy("embed")}
              className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/85 transition hover:bg-white/5">
              {copied === "embed" ? "✓ copied" : "embed"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
