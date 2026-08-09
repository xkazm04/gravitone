"use client";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { emotionMeta } from "@/lib/emotions";
import type { Job } from "@/app/voices/new/_state/machine";

/** The rebuild control and every terminal state the job can reach. */
export default function CorpusRebuildPanel({
  starting, busyRebuilding, rederiveError, stalled, done, failed, stopped, job, rebuild,
}: {
  starting: boolean;
  busyRebuilding: boolean;
  rederiveError: string | null;
  stalled: boolean;
  done: boolean;
  failed: boolean;
  stopped: boolean;
  job: Job | null;
  rebuild: () => Promise<void>;
}) {
  return (
    <div className="glass-panel mt-4 rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-white/65">
          Rebuild this character&apos;s voices from everything kept above — best take
          per emotion across every recording, on this machine, with no upload and no
          new consent (the receipt stored with the audio is the consent). Existing
          voices are replaced.
        </p>
        <button
          onClick={() => void rebuild()}
          disabled={starting || busyRebuilding}
          className="font-jetbrains shrink-0 cursor-pointer rounded-full border border-cyan-400/35 bg-cyan-400/10 px-4 py-2 text-[12px] text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-default disabled:opacity-45"
        >
          {starting ? "starting…" : busyRebuilding ? "rebuilding…" : "↻ rebuild from kept audio"}
        </button>
      </div>

      {rederiveError && <ErrorBanner>{rederiveError}</ErrorBanner>}

      {busyRebuilding && (
        <div className="font-jetbrains mt-3 text-[11px] text-white/60">
          rebuilding {job?.partial?.emotions_done ?? 0}/{job?.partial?.emotions_total ?? "?"}
          {job?.partial?.current ? ` · ${emotionMeta(job.partial.current).label}` : ""}
          {" — this loads the TTS model on this box, so it takes a while."}
        </div>
      )}
      {stalled && busyRebuilding && (
        <ErrorBanner severity="warning">
          connection to the studio is degraded — retrying. The rebuild keeps running
          server-side.
        </ErrorBanner>
      )}
      {done && (
        <p className="font-jetbrains mt-3 rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-[11px] text-emerald-200/85">
          rebuilt {job?.committed?.length ?? 0} voice
          {(job?.committed?.length ?? 0) === 1 ? "" : "s"} from the kept audio.
        </p>
      )}
      {failed && (
        <ErrorBanner>
          {job?.error ?? "the rebuild failed"} — every emotion it had already
          rebuilt was kept.
        </ErrorBanner>
      )}
      {stopped && !failed && (
        <ErrorBanner severity="warning">
          the rebuild ended before it finished. A re-derivation is never rolled
          back, so the emotions it completed are kept — the rest are unchanged.
        </ErrorBanner>
      )}
    </div>
  );
}
