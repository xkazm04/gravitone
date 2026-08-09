"use client";

// The cost-per-audio-hour leaderboard: every row a measured box or a published
// list tier, laid out on a log scale because they span three orders of
// magnitude.

import { useMemo } from "react";
import { fmtUsd } from "@/lib/switchkit";
import CostBar from "./CostBar";
import { buildRows, logWidth } from "./benchmarksRows";

export default function BenchmarksLeaderboard() {
  const rows = useMemo(buildRows, []);
  const minC = rows[0].usdPerAudioHour;
  const maxC = rows[rows.length - 1].usdPerAudioHour;
  const cheapestEl = rows.filter((r) => !r.isGravitone)[0];

  return (
    <>
      <h2 className="font-instrument text-2xl text-white">Cost per audio-hour (log scale)</h2>
      <div className="glass-panel mt-4 rounded-3xl p-6">
        <div className="space-y-4">
          {rows.map((r) => {
            const ratio = r.isGravitone ? cheapestEl.usdPerAudioHour / r.usdPerAudioHour : null;
            return (
              <div key={r.name}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className={`text-sm ${r.isGravitone ? "text-cyan-100" : "text-white/75"}`}>{r.name}</span>
                  <span className="font-jetbrains shrink-0 text-[12px] text-white/80">
                    {r.usdPerAudioHour < 0.1 ? `$${r.usdPerAudioHour.toFixed(4)}` : fmtUsd(r.usdPerAudioHour)}/audio-h
                    {ratio && ratio > 2 && (
                      <span className="ml-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-200">
                        {Math.round(ratio).toLocaleString("en-US")}× under {cheapestEl.name.replace("ElevenLabs · ", "EL ")}
                      </span>
                    )}
                  </span>
                </div>
                {/* Same log geometry, same source of truth — the bar now
                    DRAWS itself once when the row comes into view instead
                    of simply being there. The price above it is untouched. */}
                <CostBar
                  rowKey={r.name}
                  accent={r.isGravitone}
                  pct={logWidth(r.usdPerAudioHour, minC, maxC)}
                />
                <div className="font-jetbrains mt-1 text-[11px] text-white/45">{r.detail}</div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
