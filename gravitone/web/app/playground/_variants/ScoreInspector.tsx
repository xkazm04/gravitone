"use client";

// The selected region, as numbers.
//
// The pointer path (drag an edge) and the keyboard path (nudge a handle) both
// end up here: this is the same edit stated as two offsets and an emotion, so
// the region can be moved, re-aimed, heard and deleted without a pointer at
// all. Split out of ScoreEditor; it is a leaf, and the panel around it reads
// better without sixty lines of form in the middle of it.

import { emotionMeta } from "@/lib/emotions";
import type { ScoreRegion } from "./playgroundHelpers";

export default function ScoreInspector({
  region,
  index,
  text,
  choices,
  available,
  disabled = false,
  busy,
  previewing,
  onResize,
  onRetag,
  onRemove,
  onTogglePreview,
}: {
  /** The region under inspection — the one selected in the lane. */
  region: ScoreRegion;
  /** Its position in the score, which is how every edit names it. */
  index: number;
  /** PLAIN text — the same characters the offsets are counted in. */
  text: string;
  choices: string[];
  /** Emotions this Character has actually recorded (for the honest note). */
  available: string[];
  disabled?: boolean;
  /** A preview is being rendered right now. */
  busy: boolean;
  /** …and it is THIS region that is sounding. */
  previewing: boolean;
  onResize: (index: number, edge: "start" | "end", to: number) => void;
  onRetag: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onTogglePreview: () => void;
}) {
  return (
    <div className="grid gap-2 border-t border-white/8 pt-3 sm:grid-cols-[auto_auto_auto_1fr]">
      <label className="font-jetbrains flex items-center gap-1.5 text-[11px] text-white/55">
        from
        <input
          type="number"
          min={0}
          max={region.end - 1}
          value={region.start}
          disabled={disabled}
          onChange={(e) => onResize(index, "start", Number(e.target.value))}
          aria-label="Region start, character offset"
          className="font-jetbrains w-16 rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
        />
      </label>
      <label className="font-jetbrains flex items-center gap-1.5 text-[11px] text-white/55">
        to
        <input
          type="number"
          min={region.start + 1}
          max={text.length}
          value={region.end}
          disabled={disabled}
          onChange={(e) => onResize(index, "end", Number(e.target.value))}
          aria-label="Region end, character offset"
          className="font-jetbrains w-16 rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
        />
      </label>
      <select
        value={region.value}
        disabled={disabled}
        onChange={(e) => onRetag(index, e.target.value)}
        aria-label="Region emotion"
        className="font-jetbrains rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
      >
        {[...new Set([region.value, ...choices])].map((id) => (
          <option key={id} value={id} className="bg-slate-900 text-white">
            {emotionMeta(id).label}
          </option>
        ))}
      </select>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onTogglePreview}
          disabled={disabled || busy}
          className="font-jetbrains rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/75 transition enabled:hover:border-cyan-400/40 enabled:hover:text-cyan-200 disabled:opacity-40"
        >
          {busy ? "rendering…" : previewing ? "stop" : "hear this region"}
        </button>
        <button
          type="button"
          onClick={() => onRemove(index)}
          disabled={disabled}
          className="font-jetbrains rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/60 transition enabled:hover:border-rose-400/40 enabled:hover:text-rose-200 disabled:opacity-40"
        >
          delete
        </button>
      </div>
      <p className="font-jetbrains text-[10px] text-white/40 sm:col-span-4">
        {available.length > 0 && !available.includes(region.value)
          ? `${emotionMeta(region.value).label} is not recorded for this Character — the nearest recorded emotion is used, then baseline.`
          : "Drag an edge, nudge it with the arrow keys, or type an offset. Shift+arrow moves five characters."}
      </p>
    </div>
  );
}
