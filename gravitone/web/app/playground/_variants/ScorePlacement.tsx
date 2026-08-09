"use client";

// "Direct selection as …" — the placement control, stated in full.
//
// The same operation the emotion chips perform in one click, with the emotion
// named explicitly and the selection stated as a number, so the accessible path
// and the pointer path are visibly the same thing rather than two features.

import { emotionMeta } from "@/lib/emotions";

export default function ScorePlacement({
  emotion,
  choices,
  available,
  selection,
  disabled = false,
  onPending,
  onAdd,
}: {
  /** The emotion "+ add region" would place right now. */
  emotion: string;
  choices: string[];
  /** Emotions this Character has actually recorded (for the honest option). */
  available: string[];
  /** The words the composer has selected, in plain-text offsets. */
  selection: { start: number; end: number };
  disabled?: boolean;
  onPending: (value: string) => void;
  onAdd: () => void;
}) {
  const selLen = Math.abs(selection.end - selection.start);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="font-jetbrains text-[11px] text-white/55" htmlFor="score-emotion">
        direct selection as
      </label>
      <select
        id="score-emotion"
        value={emotion}
        disabled={disabled}
        onChange={(e) => onPending(e.target.value)}
        className="font-jetbrains rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
      >
        {choices.map((id) => (
          <option key={id} value={id} className="bg-slate-900 text-white">
            {emotionMeta(id).label}
            {available.length > 0 && !available.includes(id) ? " (not recorded)" : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled}
        className="font-jetbrains rounded-full border border-cyan-400/30 bg-cyan-400/5 px-3 py-1 text-[11px] text-cyan-200 transition enabled:hover:bg-cyan-400/10 disabled:opacity-40"
      >
        + add region
      </button>
      <span className="font-jetbrains text-[10px] text-white/40">
        {selLen > 0
          ? `${selLen} character${selLen === 1 ? "" : "s"} selected (${Math.min(selection.start, selection.end)}–${Math.max(selection.start, selection.end)})`
          : "select words in the text above"}
      </span>
    </div>
  );
}
