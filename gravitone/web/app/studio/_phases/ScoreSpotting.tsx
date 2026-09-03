"use client";

// SCORE / SPOTTING SESSION — the winner. Music against picture: scenes run
// along the clock, cues are spans drawn under them to scale, and clicking a
// span reads its intent. Polish round: lanes carry the same labels as the
// Cut's timeline, and the coverage line states what is scored, refused and
// silent — computed from the cues, never retyped.

import { useState } from "react";

import { CUES } from "../_studio/score";
import { PROJECT, SCENES } from "../_studio/scenes";
import { CueStatusWord, TimeRuler, spanStyle } from "../_studio/projectParts";

export default function ScoreSpotting() {
  const [focus, setFocus] = useState(CUES[1].id); // open on the refused cue
  const cue = CUES.find((c) => c.id === focus)!;

  let cursor = 0;
  const sceneCells = SCENES.map((s) => {
    const startS = cursor;
    cursor += s.targetS;
    return { s, startS };
  });

  const scoredS = CUES.filter((c) => c.status === "rendered").reduce((n, c) => n + c.durS, 0);
  const refusedS = CUES.filter((c) => c.status === "failed").reduce((n, c) => n + c.durS, 0);
  const silentS = PROJECT.totalS - scoredS - refusedS;

  return (
    <div>
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
        <div className="flex gap-3">
          <span className="w-14 shrink-0" />
          <div className="flex-1">
            <TimeRuler />
          </div>
        </div>

        {/* picture lane */}
        <div className="mt-3 flex items-center gap-3">
          <span className="font-jetbrains w-14 shrink-0 text-right text-[10px] tracking-[0.12em] text-white/40 uppercase">
            picture
          </span>
          <div className="relative h-9 flex-1">
            {sceneCells.map(({ s, startS }) => (
              <div
                key={s.id}
                style={spanStyle(startS, s.targetS)}
                className="absolute inset-y-0 rounded-md border border-white/10 bg-white/[0.04] px-2"
                title={s.slug}
              >
                <span className="font-jetbrains text-[10px] leading-9 text-white/50">sc {s.index}</span>
              </div>
            ))}
          </div>
        </div>

        {/* music lane */}
        <div className="mt-2 flex items-center gap-3">
          <span className="font-jetbrains w-14 shrink-0 text-right text-[10px] tracking-[0.12em] text-white/40 uppercase">
            music
          </span>
          <div className="relative h-11 flex-1">
            {CUES.map((c) => (
              <button
                key={c.id}
                onClick={() => setFocus(c.id)}
                style={spanStyle(c.startS, c.durS)}
                title={c.title}
                className={`absolute inset-y-0 rounded-md border px-2 text-left transition ${
                  c.status === "failed"
                    ? "border-dashed border-rose-400/40 bg-rose-400/[0.04]"
                    : "border-cyan-400/30 bg-cyan-400/[0.08]"
                } ${focus === c.id ? "ring-1 ring-cyan-300/50" : ""}`}
              >
                <span
                  className={`font-jetbrains block truncate text-[10px] leading-[2.6] ${
                    c.status === "failed" ? "text-rose-300/90" : "text-cyan-200/90"
                  }`}
                >
                  {c.title}
                </span>
              </button>
            ))}
          </div>
        </div>

        <p className="font-jetbrains mt-3 text-[11px] text-white/35">
          <span className="text-cyan-300/80">{scoredS}s scored</span>
          {" · "}
          <span className="text-rose-300/80">{refusedS}s refused</span>
          {" · "}
          {silentS}s unspotted — spans to scale on the {PROJECT.totalS}s clock
        </p>
      </div>

      <div
        className={`mt-4 rounded-2xl border p-4 ${
          cue.status === "failed" ? "border-rose-400/25 bg-rose-400/[0.03]" : "border-white/8 bg-white/[0.02]"
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-sm font-medium text-white">{cue.title}</h3>
          <span className="font-jetbrains text-[11px] text-white/40">
            {cue.startS}s → {cue.startS + cue.durS}s · {cue.bpm} bpm · {cue.model}
          </span>
          <CueStatusWord status={cue.status} />
        </div>
        <p className={`mt-1.5 text-sm leading-snug ${cue.status === "failed" ? "text-rose-200/90" : "text-slate-400"}`}>
          {cue.note}
        </p>
        {cue.status === "failed" && (
          <button className="mt-3 rounded-full bg-cyan-300/90 px-4 py-1.5 text-[13px] font-semibold text-slate-950 transition hover:brightness-110">
            retry cue
          </button>
        )}
      </div>
    </div>
  );
}
