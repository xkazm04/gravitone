"use client";

// SCRIPT / MANUSCRIPT — the winner. The document is the page: the screenplay
// reads down the left in its own typography; the visual scene plan lives as
// MARGIN NOTES on the right, aligned per scene. Focus syncs both ways —
// touch the text or touch the note, it's the same scene either way.

import { useState } from "react";

import { PROJECT, SCENES } from "../_studio/scenes";

export default function ScriptManuscript() {
  const [focus, setFocus] = useState<string>(SCENES[0].id);
  const lineCount = SCENES.reduce((n, s) => n + s.lines.length, 0);

  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        {/* the manuscript */}
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] py-2">
          {SCENES.map((s) => (
            <button
              key={s.id}
              onClick={() => setFocus(s.id)}
              className={`block w-full border-l-2 px-5 py-4 text-left transition ${
                focus === s.id
                  ? "border-cyan-300/70 bg-cyan-400/[0.05]"
                  : "border-transparent hover:bg-white/[0.03]"
              }`}
            >
              <p className="font-jetbrains flex items-baseline justify-between gap-3 text-[12px] tracking-wide text-white/80">
                <span>
                  {s.index}. {s.slug}
                </span>
                <span className="shrink-0 text-[10px] text-white/35">{s.targetS}s</span>
              </p>
              <div className="mt-2.5 space-y-2">
                {s.lines.map((l, i) => (
                  <div key={i} className="font-jetbrains text-[12px] leading-relaxed">
                    <span className="text-white/45">
                      {l.speaker}
                      {l.kind === "vo" ? " (V.O.)" : ""}:{" "}
                    </span>
                    <span className="text-slate-300">{l.text}</span>
                  </div>
                ))}
              </div>
            </button>
          ))}
        </div>

        {/* the margin */}
        <aside className="space-y-3">
          {SCENES.map((s) => (
            <button
              key={s.id}
              onClick={() => setFocus(s.id)}
              className={`block w-full rounded-xl border p-3.5 text-left transition ${
                focus === s.id
                  ? "border-cyan-400/35 bg-cyan-400/[0.05]"
                  : "border-white/8 bg-white/[0.02] hover:border-white/20"
              }`}
            >
              <p className="font-jetbrains flex items-center justify-between text-[11px] text-white/40">
                <span>scene {s.index}</span>
                <span>{s.targetS}s</span>
              </p>
              <p className="mt-1 text-sm leading-snug text-slate-300">{s.synopsis}</p>
              <p className="font-jetbrains mt-2 text-[11px] text-cyan-300/80">{s.mood}</p>
            </button>
          ))}
        </aside>
      </div>

      <p className="font-jetbrains mt-4 text-[11px] text-white/35">
        {SCENES.length} scenes · {lineCount} spoken lines · {PROJECT.totalS}s planned
      </p>
    </div>
  );
}
