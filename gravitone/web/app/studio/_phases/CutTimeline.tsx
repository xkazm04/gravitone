"use client";

// CUT / TIMELINE — the winner. The editor's grammar: three stacked tracks
// against one ruler, every clip a block to scale, drift and gaps drawn where
// they are. Polish round: a legend names the three block states, the
// playhead says what it marks, and the sync bench can snap back to zero.

import { useState } from "react";

import { TIMELINE, TRACKS } from "../_studio/score";
import { PROJECT } from "../_studio/scenes";
import { TimeRuler, spanStyle } from "../_studio/projectParts";

export default function CutTimeline() {
  const [offset, setOffset] = useState(300); // the drifting clip's ms

  const gaps = TIMELINE.filter((c) => c.status === "missing").length;

  return (
    <div>
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
        <div className="flex gap-3">
          <span className="w-14 shrink-0" />
          <div className="flex-1">
            <TimeRuler />
          </div>
        </div>

        <div className="flex gap-3">
          <span className="w-14 shrink-0" />
          <div className="relative flex-1">
            {/* static reference line at the act-two turn — a mark, not motion */}
            <span
              className="absolute inset-y-0 z-10 w-px bg-cyan-300/60"
              style={{ left: `${(13 / PROJECT.totalS) * 100}%` }}
              aria-hidden
            />
            <span
              className="font-jetbrains absolute -top-0 z-10 -translate-x-1/2 rounded bg-cyan-400/10 px-1.5 text-[9px] text-cyan-300/80"
              style={{ left: `${(13 / PROJECT.totalS) * 100}%` }}
            >
              13s · the turn
            </span>
          </div>
        </div>

        {TRACKS.map((t) => (
          <div key={t.id} className="mt-2 flex items-center gap-3">
            <span className="font-jetbrains w-14 shrink-0 text-right text-[10px] tracking-[0.12em] text-white/40 uppercase">
              {t.label}
            </span>
            <div className="relative h-10 flex-1">
              {TIMELINE.filter((c) => c.track === t.id).map((c) => (
                <div
                  key={c.id}
                  style={spanStyle(c.startS, c.durS)}
                  title={`${c.label} · ${c.startS}s → ${c.startS + c.durS}s`}
                  className={`absolute inset-y-0 overflow-hidden rounded-md border px-2 ${
                    c.status === "ok"
                      ? "border-cyan-400/25 bg-cyan-400/[0.07]"
                      : c.status === "drift"
                        ? "border-amber-400/40 bg-amber-400/[0.06]"
                        : "border-dashed border-rose-400/35 bg-transparent"
                  }`}
                >
                  <span
                    className={`font-jetbrains block truncate text-[10px] leading-[2.4] ${
                      c.status === "ok"
                        ? "text-white/60"
                        : c.status === "drift"
                          ? "text-amber-200/90"
                          : "text-rose-300/80"
                    }`}
                  >
                    {c.status === "missing" ? `${c.label} — missing` : c.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}

        <p className="font-jetbrains mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-white/35">
          <span><span className="text-cyan-300/70">▬</span> placed</span>
          <span><span className="text-amber-300/80">▬</span> drift</span>
          <span><span className="text-rose-300/70">▭</span> missing — drawn, not hidden</span>
        </p>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {/* the sync bench */}
        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.03] p-4">
          <p className="font-jetbrains text-[11px] tracking-[0.14em] text-amber-300/90 uppercase">
            sync · heist beat vo
          </p>
          <p className="mt-1.5 text-sm leading-snug text-slate-300">
            The line lands{" "}
            {offset === 0 ? (
              <span className="text-cyan-300">on the mark</span>
            ) : (
              <span className="text-amber-200">
                {Math.abs(offset)}ms {offset > 0 ? "late" : "early"}
              </span>
            )}{" "}
            against the rooftop cut. Nudge until the word “gate” hits the turn.
          </p>
          <div className="font-jetbrains mt-3 flex items-center gap-3 text-[12px]">
            <button
              onClick={() => setOffset((o) => o - 50)}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-white/70 transition hover:bg-white/5"
            >
              −50ms
            </button>
            <span className="min-w-16 text-center text-white">
              {offset >= 0 ? `+${offset}` : offset}ms
            </span>
            <button
              onClick={() => setOffset((o) => o + 50)}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-white/70 transition hover:bg-white/5"
            >
              +50ms
            </button>
            {offset !== 0 && (
              <button
                onClick={() => setOffset(0)}
                className="ml-auto text-white/45 transition hover:text-white"
              >
                snap to mark
              </button>
            )}
          </div>
        </div>

        {/* the honest wrap state */}
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
          <p className="font-jetbrains text-[11px] tracking-[0.14em] text-white/40 uppercase">this cut</p>
          <p className="mt-1.5 text-sm leading-snug text-slate-400">
            {PROJECT.totalS}s of picture planned,{" "}
            <span className="text-rose-300">{gaps} blocks missing</span> (rooftop render rejected,
            door still rendering, waterline unpicked, cue-2 refused). Preview plays what exists and
            holds black over the gaps.
          </p>
        </div>
      </div>
    </div>
  );
}
