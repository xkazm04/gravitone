"use client";

// The capacity planner: two numbers in, a box and an env block out — sized from
// the measured knee data rather than from a rule of thumb.

import { useMemo, useState } from "react";
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import { planCapacity, planEnvBlock } from "@/lib/benchmarks";
import { fmtUsd } from "@/lib/switchkit";

export default function BenchmarksPlanner() {
  const [streams, setStreams] = useState(4);
  const [dailyMin, setDailyMin] = useState(600);
  const plan = useMemo(() => planCapacity(streams, dailyMin), [streams, dailyMin]);
  const { copy: copyText, copied, failed } = useCopyFeedback();
  const copyEnv = () => copyText(planEnvBlock(plan));

  return (
    <>
      <h2 className="font-instrument text-2xl text-white">What box do I need?</h2>
      <p className="mt-2 max-w-2xl text-sm text-slate-300/80">
        Sized from the measured knee data, using the scaling law the benchmarks surfaced: run
        single-worker processes, not in-process threads.
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="glass-panel rounded-3xl p-6">
          <label className="block">
            <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">peak concurrent streams</span>
            <input
              type="number" min={1} max={500} value={streams}
              onChange={(e) => setStreams(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              className="font-jetbrains mt-2 w-full rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white focus:border-cyan-400/40 focus:outline-none"
            />
          </label>
          <label className="mt-5 block">
            <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">daily audio minutes</span>
            <input
              type="number" min={0} max={1_000_000} value={dailyMin}
              onChange={(e) => setDailyMin(Math.max(0, Math.min(1_000_000, Number(e.target.value) || 0)))}
              className="font-jetbrains mt-2 w-full rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white focus:border-cyan-400/40 focus:outline-none"
            />
          </label>
          <p className="font-jetbrains mt-4 text-[11px] leading-relaxed text-white/45">
            Provisioned for max(streams, 4× the daily average arrival rate) = {plan.need.audPerS.toFixed(1)} audio-s/s.
          </p>
        </div>

        <div className="glass-panel rounded-3xl p-6">
          <div className="flex items-baseline justify-between">
            <span className="font-instrument text-xl text-white">
              {plan.instances}× {plan.box.instance}
            </span>
            <span className="font-instrument text-2xl text-cyan-100">
              {fmtUsd(plan.monthlyUsd)}<span className="text-sm text-cyan-100/50">/mo 24·7</span>
            </span>
          </div>
          <div className="font-jetbrains mt-1 text-[11px] text-white/55">
            {plan.box.platform} {plan.box.cpu} · {plan.replicas} processes · {plan.headroomPct}% headroom
            {plan.elMonthlyUsd != null && plan.elMonthlyUsd > plan.monthlyUsd && (
              <span className="ml-2 text-emerald-300">
                same volume ≈ {fmtUsd(plan.elMonthlyUsd)}/mo at ElevenLabs
              </span>
            )}
          </div>
          <pre className="font-jetbrains mt-4 overflow-x-auto rounded-2xl border border-white/8 bg-black/40 p-4 text-[11px] leading-relaxed text-cyan-100/90">
            {planEnvBlock(plan)}
          </pre>
          <button onClick={copyEnv}
            className="font-jetbrains mt-3 cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/85 transition hover:bg-white/5">
            {failed ? "copy blocked — select it" : copied ? "✓ copied" : "copy env config"}
          </button>
        </div>
      </div>
    </>
  );
}
