"use client";

// Shared leaves for the lifecycle phases: frame stills, the status words,
// and the one time ruler + span geometry every timeline surface computes
// from the same source, so the pictures stay to scale.

import type { ClipStatus, CueStatus, FrameCandidate } from "./projectTypes";
import { PROJECT } from "./scenes";

/** A frame candidate as a still — gradient mock, pick drawn on it. */
export function FrameThumb({
  frame,
  picked,
  className = "h-24",
  onClick,
}: {
  frame: FrameCandidate;
  picked?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`relative w-full overflow-hidden rounded-xl border text-left transition ${
        picked ? "border-cyan-300/60" : "border-white/8"
      } ${onClick ? "hover:border-cyan-400/35" : ""} ${className}`}
    >
      <div className={`absolute inset-0 bg-gradient-to-br ${frame.tone}`} aria-hidden />
      {picked && (
        <span className="font-jetbrains absolute top-1.5 left-1.5 rounded bg-cyan-300/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-950">
          PICKED
        </span>
      )}
    </Tag>
  );
}

const CLIP_WORD: Record<ClipStatus, { word: string; cls: string }> = {
  rendered: { word: "rendered", cls: "text-cyan-300" },
  rendering: { word: "rendering", cls: "text-cyan-300/70" },
  failed: { word: "rejected", cls: "text-rose-300" },
  "not-started": { word: "not started", cls: "text-white/40" },
};

export function ClipStatusWord({ status }: { status: ClipStatus }) {
  const s = CLIP_WORD[status];
  return <span className={`font-jetbrains text-[11px] ${s.cls}`}>{s.word}</span>;
}

const CUE_WORD: Record<CueStatus, { word: string; cls: string }> = {
  rendered: { word: "rendered", cls: "text-cyan-300" },
  failed: { word: "refused", cls: "text-rose-300" },
  draft: { word: "draft", cls: "text-white/40" },
};

export function CueStatusWord({ status }: { status: CueStatus }) {
  const s = CUE_WORD[status];
  return <span className={`font-jetbrains text-[11px] ${s.cls}`}>{s.word}</span>;
}

/** Percent geometry against the project clock. */
export const spanStyle = (startS: number, durS: number) => ({
  left: `${(startS / PROJECT.totalS) * 100}%`,
  width: `${(durS / PROJECT.totalS) * 100}%`,
});

/** The one time ruler. Ticks every 5s, honest to PROJECT.totalS. */
export function TimeRuler() {
  const ticks = [];
  for (let s = 0; s <= PROJECT.totalS; s += 5) ticks.push(s);
  return (
    <div className="relative h-5 border-b border-white/8">
      {ticks.map((s) => (
        <span
          key={s}
          className="font-jetbrains absolute -translate-x-1/2 text-[10px] text-white/30"
          style={{ left: `${(s / PROJECT.totalS) * 100}%` }}
        >
          {s}s
        </span>
      ))}
    </div>
  );
}
