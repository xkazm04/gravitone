"use client";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { SovereignLimits } from "../_loaders/ScanReport";
import type { ModeInfo } from "../_state/machine";

/** Cloud quality vs sovereign, described in the BACKEND's own words. */
export default function VoiceNewModePanel({
  ingestMode, setIngestMode, modes,
}: {
  ingestMode: "auto" | "sovereign";
  setIngestMode: (m: "auto" | "sovereign") => void;
  modes: { modeInfo: ModeInfo | null; modeInfoFailed: boolean };
}) {
  const { modeInfo, modeInfoFailed } = modes;
  return (
    <div className="glass-panel mt-4 rounded-2xl p-5">
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setIngestMode("auto")} aria-pressed={ingestMode === "auto"}
          className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] transition ${ingestMode === "auto" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"}`}>
          Cloud quality
        </button>
        <button onClick={() => setIngestMode("sovereign")} aria-pressed={ingestMode === "sovereign"}
          className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] transition ${ingestMode === "sovereign" ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-white/12 text-white/60 hover:text-white"}`}>
          🔒 Sovereign — audio never leaves this machine
        </button>
      </div>
      {/* Everything below is the BACKEND's description of the modes.
          This panel used to re-type the sovereign limits by hand, so the
          two could drift with nothing to catch it, and `auto` never
          said which mode it would actually resolve to. */}
      <div className="mt-3 space-y-2">
        {modeInfoFailed && (
          <ErrorBanner severity="warning">
            couldn&apos;t load what each mode does from the backend — the limits of
            whichever mode runs are stated again once the scan starts.
          </ErrorBanner>
        )}
        {!modeInfo && !modeInfoFailed && (
          <p className="font-jetbrains text-[11px] text-white/40">loading what each mode does…</p>
        )}
        {ingestMode === "sovereign" ? (
          modeInfo && (
            <p className="font-jetbrains max-w-2xl text-[11px] leading-relaxed text-white/50">
              {modeInfo.sovereign.note}
            </p>
          )
        ) : (
          <p className="font-jetbrains max-w-2xl text-[11px] leading-relaxed text-white/50">
            Uses ElevenLabs (diarize + isolate) and Gemini (emotion labels) when the
            backend has keys, and the local sovereign pipeline when it doesn&apos;t.
            {modeInfo?.resolved_auto === "sovereign" &&
              " This backend has no cloud keys configured, so auto will run the local pipeline — with the limits below."}
            {modeInfo?.resolved_auto === "cloud" &&
              " This backend has cloud keys, so auto will run the cloud pipeline."}
          </p>
        )}
        {modeInfo && (ingestMode === "sovereign" || modeInfo.resolved_auto === "sovereign") && (
          <SovereignLimits limits={modeInfo.sovereign.limits} />
        )}
      </div>
    </div>
  );
}
