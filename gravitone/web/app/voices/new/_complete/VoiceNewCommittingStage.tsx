"use client";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { emotionMeta } from "@/lib/emotions";
import { CANCEL_UNFINISHED } from "../_state/failures";
import type { Job } from "../_state/machine";

/** The single-commit progress screen. */
export default function VoiceNewCommittingStage({
  job, selected, cancelFailed, cancelCommit, startOver,
}: {
  job: Job | null;
  selected: Set<string>;
  cancelFailed: string | null;
  cancelCommit: () => void;
  startOver: () => void;
}) {
  const total = job?.partial?.emotions_total ?? selected.size;
  const done = job?.partial?.emotions_done ?? 0;
  const current = job?.partial?.current ?? null;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="mt-8 text-center">
      <div className="font-jetbrains text-[12px] uppercase tracking-widest text-cyan-300">
        cloning voices · {done}/{total}
      </div>
      <p className="mt-2 text-sm text-white/60">
        {current ? <>Cloning <span className="text-white">{emotionMeta(current).label}</span> on the CPU engine…</> : "Cloning on the CPU engine…"}
      </p>
      <div className="mx-auto mt-5 h-1.5 w-64 overflow-hidden rounded-full bg-white/10"
        role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
        aria-label={`Cloning voices, ${done} of ${total} done`}>
        <div className="h-full rounded-full bg-cyan-300 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <button onClick={cancelCommit}
        className="font-jetbrains mt-6 cursor-pointer rounded-full border border-white/15 px-5 py-2 text-[13px] text-white/70 transition hover:bg-white/5">
        {cancelFailed ? "Try cancelling again" : "Cancel"}
      </button>
      {/* The cancel did not happen, and the copy names the state that
          leaves behind rather than the one the user asked for. */}
      {cancelFailed && (
        <ErrorBanner severity="warning" className="mx-auto mt-4 max-w-xl text-left">
          <span className="block">
            {cancelFailed} — {CANCEL_UNFINISHED}. This screen keeps
            following the job, so if the clone finishes you will see it.
          </span>
          <button onClick={startOver}
            className="mt-2 cursor-pointer underline decoration-dotted underline-offset-4 transition hover:text-amber-100">
            leave this screen anyway
          </button>
        </ErrorBanner>
      )}
    </div>
  );
}
