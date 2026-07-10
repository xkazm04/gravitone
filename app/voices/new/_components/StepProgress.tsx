"use client";

// Animated multistep progress for the ingestion pipeline. Each step's motionized
// glyph is ghosted when pending, self-draws + glows while active, and locks in
// solid (✓) when done. A connecting rail fills as steps complete.

import { useId } from "react";
import { motion } from "framer-motion";
import { STEP_GLYPHS } from "@/lib/glyphs/steps";

export type StepState = "pending" | "active" | "done";
export type Step = { key: string; label: string; state: StepState };

function StepGlyph({ stepKey, state }: { stepKey: string; state: StepState }) {
  const gid = useId().replace(/:/g, "");
  const glyph = STEP_GLYPHS[stepKey];
  if (!glyph) return null;
  const on = state !== "pending";
  return (
    <svg viewBox={glyph.viewBox} width={46} height={46} className="overflow-visible" aria-hidden>
      <defs>
        <filter id={`g-${gid}`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g filter={state === "active" ? `url(#g-${gid})` : undefined} opacity={on ? 1 : 0.22}>
        {glyph.paths.map((p, i) => (
          <motion.path
            key={i} d={p.d} fill={p.fill}
            initial={false}
            animate={{ opacity: on ? 1 : 0.4, scale: on ? 1 : 0.9 }}
            transition={{ duration: 0.4, delay: state === "active" ? (i % 8) * 0.04 : 0 }}
            style={{ transformOrigin: "center", transformBox: "fill-box" }}
          />
        ))}
      </g>
    </svg>
  );
}

export default function StepProgress({ steps }: { steps: Step[] }) {
  const doneCount = steps.filter((s) => s.state === "done").length;
  const activeIdx = steps.findIndex((s) => s.state === "active");
  const fill = Math.max(doneCount, activeIdx >= 0 ? activeIdx : 0) / Math.max(1, steps.length - 1);

  return (
    <div className="relative">
      {/* rail */}
      <div className="absolute left-[23px] right-[23px] top-[23px] h-px bg-white/10" />
      <motion.div
        className="absolute left-[23px] top-[23px] h-px bg-gradient-to-r from-cyan-400 to-cyan-200"
        initial={{ width: 0 }} animate={{ width: `calc(${fill * 100}% * (1 - 46px / 100%))` }}
        style={{ right: "23px" }}
      />
      <div className="relative grid" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
        {steps.map((s) => (
          <div key={s.key} className="flex flex-col items-center gap-2 text-center">
            <div
              className="grid h-12 w-12 place-items-center rounded-full border bg-[#0b0e15] transition-colors"
              style={{
                borderColor: s.state === "done" ? "hsl(160 70% 55% / .6)"
                  : s.state === "active" ? "hsl(190 90% 60% / .6)" : "rgba(255,255,255,0.12)",
              }}
            >
              <StepGlyph stepKey={s.key} state={s.state} />
            </div>
            <div className="font-jetbrains text-[11px]">
              <span className={s.state === "pending" ? "text-white/45" : "text-white"}>{s.label}</span>
              {s.state === "done" && <span className="ml-1 text-emerald-300">✓</span>}
              {s.state === "active" && <span className="ml-1 text-cyan-300">…</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
