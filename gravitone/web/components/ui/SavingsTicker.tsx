"use client";

// Live savings counter: lifetime audio served by this deployment (from the
// engine's audio_seconds_total metric) priced at ElevenLabs' MARGINAL per-char
// rate — audio_seconds_total is cumulative, so pricing it with the monthly-tier
// estimator would compare a lifetime total against one month's subscription.
// Renders nothing until the backend is reachable and has served audio.

import { elCostForLifetimeAudioMinutes, fmtUsd } from "@/lib/switchkit";
import { useHealthPoll } from "@/lib/useHealthPoll";

export default function SavingsTicker() {
  // Shared poller — BenchmarksView reads the same endpoint on the same cadence.
  const { health } = useHealthPoll();
  const raw = health?.metrics?.audio_seconds_total;
  const seconds = typeof raw === "number" ? raw : null;

  if (seconds === null || seconds < 1) return null;

  const minutes = seconds / 60;
  const saved = elCostForLifetimeAudioMinutes(minutes);
  return (
    <span
      className="font-jetbrains hidden items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/5 px-3 py-1 text-[11px] text-emerald-200/90 lg:inline-flex"
      title="Lifetime audio served by this deployment, priced at ElevenLabs' marginal per-character rate"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
      {minutes >= 1 ? `${Math.floor(minutes).toLocaleString("en-US")} min served` : `${Math.round(seconds)}s served`}
      {" · "}≈{fmtUsd(saved)} kept vs ElevenLabs
    </span>
  );
}
