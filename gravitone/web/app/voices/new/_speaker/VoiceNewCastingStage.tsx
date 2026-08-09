"use client";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { castProgress, memberStatusLabel } from "../_state/cast";
import { CANCEL_UNFINISHED } from "../_state/failures";
import type { Job } from "../_state/machine";

/** The cast's progress screen, one line per Character being built. */
export default function VoiceNewCastingStage({
  job, cancelFailed, cancelCommit,
}: {
  job: Job | null;
  cancelFailed: string | null;
  cancelCommit: () => void;
}) {
  const { total, settled, current } = castProgress(job?.cast);
  const members = job?.cast?.members ?? [];
  const pct = total ? Math.round((settled / total) * 100) : 0;
  return (
    <div className="mt-8">
      <div className="font-jetbrains text-[12px] uppercase tracking-widest text-cyan-300">
        casting · {settled}/{total || "…"}
      </div>
      <h2 className="font-instrument mt-2 text-3xl text-white">
        Building {total || "the"} character{total === 1 ? "" : "s"} from one recording.
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-white/60">
        {current
          ? <>Now: <span className="text-white">{current.character || current.speaker_id}</span> — {memberStatusLabel(current)}.</>
          : "Labelling and cloning each speaker in turn on the CPU engine…"}
      </p>
      <div className="mt-5 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-white/10"
        role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
        aria-label={`Casting characters, ${settled} of ${total} settled`}>
        <div className="h-full rounded-full bg-cyan-300 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-5 space-y-2">
        {members.map((m) => (
          <div key={m.speaker_id} className="glass-panel flex flex-wrap items-center gap-3 rounded-xl px-5 py-4">
            <span className={`h-2 w-2 shrink-0 rounded-full ${m.status === "done" ? "bg-emerald-300" : m.status === "error" ? "bg-rose-400" : m.status === "pending" ? "bg-white/25" : "bg-cyan-300"}`} />
            <span className="text-sm text-white">{m.character || m.speaker_id}</span>
            <span className="font-jetbrains text-[11px] text-white/45">{m.speaker_id}</span>
            <span className="font-jetbrains ml-auto text-[11px] text-white/60">
              {memberStatusLabel(m)}
            </span>
            {/* A speaker that could not be cast, said the moment it is
                known — the others keep going. */}
            {m.status === "error" && m.error && (
              <span className="font-jetbrains w-full text-[11px] leading-snug text-amber-200/80">
                {m.error}
              </span>
            )}
          </div>
        ))}
      </div>
      <button onClick={cancelCommit}
        className="font-jetbrains mt-6 cursor-pointer rounded-full border border-white/15 px-5 py-2 text-[13px] text-white/70 transition hover:bg-white/5">
        {cancelFailed ? "Try cancelling again" : "Cancel"}
      </button>
      <p className="font-jetbrains mt-2 text-[11px] text-white/40">
        Cancelling stops the cast where it is — characters already finished are kept.
      </p>
      {cancelFailed && (
        <ErrorBanner severity="warning" className="mt-4 max-w-xl">
          {cancelFailed} — {CANCEL_UNFINISHED}. This screen keeps following the job,
          so if the cast finishes you will see it.
        </ErrorBanner>
      )}
    </div>
  );
}
