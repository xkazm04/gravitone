"use client";

// The audition rack: up to three rendered candidates for ONE region, each one
// playable on its own. It draws what `usePunchSession` holds and owns nothing —
// commit and discard are the session's verbs, passed down.

import TakePlayer from "@/components/ui/TakePlayer";
import { emotionMeta } from "@/lib/emotions";
import type { Variant } from "./variantStore";

export default function PunchLanes({ variants, committing, onCommit, onDiscard }: {
  variants: Variant[];
  committing: boolean;
  onCommit: (v: Variant) => void;
  onDiscard: (v: Variant) => void;
}) {
  return (
    <div className="mt-3 space-y-2">
      <span className="font-jetbrains text-[10px] uppercase tracking-widest text-white/45">
        lanes · audition, then commit one
      </span>
      {variants.map((v) => (
        <div key={v.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/20 p-2">
          <span className="font-jetbrains grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/15 text-[11px] text-white/80">
            {v.lane}
          </span>
          {v.url && <TakePlayer src={v.url} compact label={`lane ${v.lane}`} hue={emotionMeta(v.emotion ?? "baseline").hue} className="min-w-0 flex-1" />}
          <span className="font-jetbrains shrink-0 text-[10px] text-white/50">
            {v.seconds}s · {v.characterName}{v.emotion ? ` · ${v.emotion}` : ""}
          </span>
          <button
            onClick={() => onCommit(v)}
            disabled={committing}
            title="Splice this lane into a NEW take — the original stays in the log"
            className="font-jetbrains shrink-0 cursor-pointer rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] text-emerald-200 transition hover:bg-emerald-400/20 disabled:opacity-40"
          >
            {committing ? "splicing…" : "✓ commit lane"}
          </button>
          <button
            onClick={() => onDiscard(v)}
            aria-label={`Discard lane ${v.lane}`}
            title="Discard this lane"
            className="font-jetbrains shrink-0 cursor-pointer rounded-lg border border-white/12 px-2 py-1 text-[11px] text-white/55 transition hover:border-rose-400/40 hover:text-rose-200"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
