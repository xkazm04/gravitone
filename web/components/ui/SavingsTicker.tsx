"use client";

// Live savings counter: lifetime audio served by this deployment (from the
// engine's audio_seconds_total metric) priced at ElevenLabs list rates.
// Renders nothing until the backend is reachable and has served audio.

import { useEffect, useState } from "react";
import { elCostForAudioMinutes, fmtUsd } from "@/lib/switchkit";

type Health = { status?: string; metrics?: { audio_seconds_total?: number } };

export default function SavingsTicker() {
  const [seconds, setSeconds] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (!r.ok) return;
        const h = (await r.json()) as Health;
        const s = h.metrics?.audio_seconds_total;
        if (alive && typeof s === "number") setSeconds(s);
      } catch {
        /* backend away — ticker stays hidden */
      }
    };
    void poll();
    const id = setInterval(poll, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (seconds === null || seconds < 1) return null;

  const minutes = seconds / 60;
  const saved = elCostForAudioMinutes(minutes);
  return (
    <span
      className="font-jetbrains hidden items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/5 px-3 py-1 text-[11px] text-emerald-200/90 lg:inline-flex"
      title="Lifetime audio served by this deployment, priced at ElevenLabs list rates"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
      {minutes >= 1 ? `${Math.floor(minutes).toLocaleString("en-US")} min served` : `${Math.round(seconds)}s served`}
      {" · "}≈{fmtUsd(saved)} kept vs ElevenLabs
    </span>
  );
}
