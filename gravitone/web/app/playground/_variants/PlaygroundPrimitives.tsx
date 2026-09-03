"use client";

// The console's three small presentational helpers. They live together because
// they are the pieces the console DRAWS WITH rather than pieces of the console:
// a waveform, a labelled knob, and the playhead subscription that keeps a
// 4Hz tick out of the take-card list.

import type { ReactNode } from "react";
import { usePlaybackProgress, type ProgressSource } from "./useAudioPlayer";

export function Bars({ peaks, progress = 0, active = false, className = "" }: { peaks: number[]; progress?: number; active?: boolean; className?: string }) {
  return (
    <div className={`flex items-end gap-[2px] ${className}`} aria-hidden>
      {peaks.map((h, i) => {
        const played = active && i / peaks.length <= progress;
        return <span key={i} className={`w-[2px] shrink-0 rounded-full transition-colors duration-75 ${played ? "bg-cyan-300" : "bg-white/25"}`} style={{ height: `${Math.max(6, Math.round(h * 100))}%` }} />;
      })}
    </div>
  );
}

export function Slider({ label, hint, value, min, max, step, onChange, format }: {
  label: string; hint: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format: (v: number) => string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/65">{label}</span>
        <span className="font-jetbrains text-[12px] text-cyan-300">{format(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-cyan-300" />
      <p className="font-jetbrains mt-1 text-[11px] text-white/55">{hint}</p>
    </div>
  );
}

/**
 * Whatever it wraps, re-rendered on the PLAYHEAD and nothing else.
 *
 * Same fix as RenderStatus below, for the other four-times-a-second tick in
 * this file: playback progress used to be console state, so a playing take
 * re-rendered every take card — each one an AnimatePresence `layout` child that
 * re-measures — for the whole length of the clip. The children this draws are
 * the only things on screen that move with the playhead.
 *
 * `active` false subscribes to nothing: a row that is not playing is not
 * waiting on a number it would render as 0 either way.
 */
export function LiveProgress({ source, active = true, children }: {
  source: ProgressSource; active?: boolean; children: (progress: number) => ReactNode;
}) {
  return <>{children(usePlaybackProgress(active ? source : null))}</>;
}
