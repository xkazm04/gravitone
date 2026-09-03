"use client";

import EmotionIcon from "@/components/ui/EmotionIcon";
import { emotionMeta } from "@/lib/emotions";
import type { AuditionCell, AuditionTarget } from "./audition";

/** What one tile says it is doing. Never a bare spinner: a state with no
 *  sentence is the shape this codebase calls a stuck spinner. */
function cellLine(cell: AuditionCell | undefined): { text: string; tone: string } {
  switch (cell?.kind) {
    case "queued":
      return { text: "queued", tone: "text-white/45" };
    case "rendering":
      return { text: "rendering…", tone: "text-cyan-300/80" };
    case "waiting":
      return {
        // The backend's own Retry-After, ticking. "The engine is full and told
        // us when to come back" is a different fact from "this failed", and the
        // user can act on exactly one of them (wait).
        text: `engine full — retrying in ${cell.seconds}s (${cell.attempt})`,
        tone: "text-amber-300",
      };
    case "ready":
      return cell.cached
        ? { text: "ready · cached", tone: "text-emerald-300/80" }
        : { text: "ready", tone: "text-emerald-300/80" };
    case "failed":
      return { text: cell.reason, tone: "text-rose-300" };
    default:
      return { text: "not auditioned", tone: "text-white/35" };
  }
}

/** One Voice's place in the run: what it rendered, and the take it holds. */
export default function EmotionAuditionTile({ target: t, cell, isPlaying, name, onPlay }: {
  target: AuditionTarget;
  cell: AuditionCell | undefined;
  isPlaying: boolean;
  name: string;
  onPlay: () => void;
}) {
  const status = cellLine(cell);
  const ready = cell?.kind === "ready";
  const hue = emotionMeta(t.emotion).hue;
  // A computed take must never audition with a recording's visual weight. The
  // violet is the rack's own derived accent, not a new one, so the two surfaces
  // read as one statement about the same voice.
  const derivedFrom = t.derivedFrom || null;
  return (
    <div
      className={`rounded-lg border p-2.5 transition ${
        cell?.kind === "failed"
          ? "border-rose-400/25 bg-rose-400/[0.04]"
          : isPlaying
            ? "border-cyan-400/40 bg-cyan-400/[0.06]"
            : "border-white/8 bg-white/[0.02]"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
          <EmotionIcon emotion={t.emotion} size={20} dim={!ready} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
          {t.label}
        </span>
        <button
          onClick={onPlay}
          disabled={!ready}
          // Named for the AUDITION, not just the emotion: the rack row
          // above has its own "Play Baseline", and two controls sharing
          // one accessible name is a real ambiguity for anyone who
          // navigates by name rather than by position. "derived" is part
          // of the NAME, not only of the visuals — a listener who
          // navigates by name is exactly the one who cannot see the chip.
          aria-label={`${isPlaying ? "Stop" : "Play"} the auditioned `
            + `${derivedFrom ? "derived " : ""}${t.label} take`}
          title={ready
            ? `Play ${name}'s ${t.label} take of this line`
              + (derivedFrom ? " — computed, not performed" : "")
            : "Audition first"}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] text-slate-950 transition hover:brightness-110 disabled:opacity-25"
          style={{ background: `hsl(${hue} 85% 64%)` }}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
      </div>
      {derivedFrom && (
        <p
          title={`This take was COMPUTED from a baseline plus the emotion direction taken from ${derivedFrom}. Nobody performed it — it can show you what the algebra sounds like, not that ${name} sounds like this.`}
          className="font-jetbrains mt-2 truncate rounded bg-violet-400/10 px-1.5 py-0.5 text-[10px] text-violet-200"
        >
          derived · from {derivedFrom}
        </p>
      )}
      {/* Not a live region: eight tiles each announcing themselves
          would shout over each other (and over the page's own status
          region). The run gets ONE announcement, above. */}
      <p
        title={cell?.kind === "failed" ? cell.reason : undefined}
        className={`font-jetbrains mt-2 line-clamp-2 text-[11px] leading-relaxed ${status.tone}`}
      >
        {status.text}
      </p>
    </div>
  );
}
