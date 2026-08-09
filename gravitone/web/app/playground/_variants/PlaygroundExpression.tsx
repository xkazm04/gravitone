"use client";

// THE EXPRESSION PANEL — the model's three REAL knobs, and the sentence saying
// why there is no emotion slider among them.

import { Slider } from "./PlaygroundPrimitives";
import { DEFAULT_EXPRESSION, type Expression } from "./playgroundHelpers";

export function PlaygroundExpression({ expr, setExpr }: {
  expr: Expression;
  setExpr: (e: Expression) => void;
}) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="font-jetbrains mb-4 flex items-center justify-between text-[11px] uppercase tracking-widest text-white/60">
        <span>expression</span>
        <button onClick={() => setExpr(DEFAULT_EXPRESSION)} className="text-white/60 transition hover:text-white">reset</button>
      </div>
      <div className="space-y-5">
        <Slider label="temperature" hint="consistent ⟷ expressive" value={expr.temperature} min={0.5} max={1.0} step={0.05}
          onChange={(v) => setExpr({ ...expr, temperature: v })} format={(v) => v.toFixed(2)} />
        <Slider label="stability" hint="0 = off · tames a high temperature" value={expr.stability} min={0} max={1} step={0.05}
          onChange={(v) => setExpr({ ...expr, stability: v })} format={(v) => (v < 0.01 ? "off" : v.toFixed(2))} />
        <Slider label="quality" hint="decode steps — higher is slower" value={expr.quality} min={1} max={5} step={1}
          onChange={(v) => setExpr({ ...expr, quality: v })} format={(v) => `${v} step${v > 1 ? "s" : ""}`} />
      </div>
      <p className="font-jetbrains mt-5 border-t border-white/8 pt-3 text-[11px] leading-relaxed text-white/55">
        Pocket TTS exposes no emotion or speed parameter — expression comes from the reference
        audio. That is why emotions are separate Voices, and these are the model&apos;s real knobs.
      </p>
    </div>
  );
}
