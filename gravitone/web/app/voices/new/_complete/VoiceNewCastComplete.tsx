"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { emotionMeta } from "@/lib/emotions";
import { castOutcome } from "../_state/cast";
import type { CastJob } from "../_state/machine";
import VoiceNewPanelLoading from "../_shell/VoiceNewPanelLoading";
// Reachable only from a finished CAST, and it fetches the transcript on mount —
// neither belongs in the first paint of a dropzone.
const OpenAsScene = dynamic(() => import("../_review/OpenAsScene"), {
  ssr: false, loading: () => <VoiceNewPanelLoading label="reading this recording’s dialogue…" />,
});

/** The completion screen for a cast — one block per Character it tried. */
export default function VoiceNewCastComplete({
  cast, jobId, vaultWarn, startOver,
}: {
  cast: CastJob;
  jobId: string | null;
  vaultWarn: boolean;
  startOver: () => void;
}) {
  const outcome = castOutcome(cast);
  if (!outcome) return null;
  return (
    <div className="mt-8 max-w-3xl">
      <div className="glass-panel rounded-2xl p-5">
        <div className={`font-jetbrains text-[11px] uppercase tracking-widest ${outcome.failed.length ? "text-amber-300" : "text-emerald-300"}`}>
          {outcome.failed.length ? "cast · partly" : "cast"}
        </div>
        <h2 className="font-instrument mt-2 text-3xl text-white">{outcome.headline}</h2>
        <p className="mt-2 max-w-2xl text-sm text-white/60">
          All of them from one scan of this recording — one transcription, one
          isolation, {outcome.made.length} character{outcome.made.length === 1 ? "" : "s"}.
        </p>
        {/* A cast that was cancelled (or reaped) before every ticked
            speaker was reached. The finished ones are real. */}
        {cast.abandoned && (
          <ErrorBanner severity="warning" className="mt-3">
            This cast stopped before every speaker was reached — the characters
            listed below were finished and are yours; the rest were not started.
          </ErrorBanner>
        )}
        {/* The per-JOB external-call budget covered the WHOLE cast, and
            when a cap was reached that is an outcome, not a footnote:
            later speakers kept their fast-model labels. */}
        {cast.budget_note && (
          <ErrorBanner severity="warning" className="mt-3">{cast.budget_note}</ErrorBanner>
        )}

        <div className="mt-5 space-y-3">
          {outcome.made.map((m) => (
            <div key={m.speaker_id} className="rounded-xl border border-white/8 bg-white/[0.02] px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-300" />
                <span className="text-sm text-white">{m.character}</span>
                <span className="font-jetbrains text-[11px] text-white/40">from {m.speaker_id}</span>
                {m.character_id && (
                  <Link href={`/voices/${m.character_id}`}
                    className="font-jetbrains ml-auto rounded-full border border-cyan-400/35 bg-cyan-400/10 px-3 py-1 text-[11px] text-cyan-100 transition hover:bg-cyan-400/20">
                    open →
                  </Link>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(m.voices ?? []).map((v) => {
                  const em = emotionMeta(v.emotion);
                  return (
                    <span key={v.voice_id}
                      className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] text-white/80">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${em.hue} 80% 62%)` }} />{em.label}
                      {typeof v.identity === "number" && (
                        <span className="tabular-nums text-cyan-200/85">identity {v.identity.toFixed(2)}</span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
          {/* NOT an all-or-nothing lie: the speakers that could not be
              cast are listed with the service's own reason, and nothing
              of theirs was left behind in the roster. */}
          {outcome.failed.map((m) => (
            <div key={m.speaker_id} className="rounded-xl border border-amber-400/25 bg-amber-400/[0.04] px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-rose-400" />
                <span className="text-sm text-white">{m.character || m.speaker_id}</span>
                <span className="font-jetbrains text-[11px] text-white/40">from {m.speaker_id}</span>
                <span className="font-jetbrains ml-auto text-[11px] text-amber-200/85">not cast</span>
              </div>
              <p className="font-jetbrains mt-1 text-[11px] leading-relaxed text-amber-200/80">
                {m.error ?? "this speaker could not be cast"} — nothing was added to your
                roster for them.
              </p>
            </div>
          ))}
        </div>

        {vaultWarn && (
          <p className="font-jetbrains mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/85">
            Voices cloned, but a consent receipt couldn’t be saved to your vault.
            Reload “My Voices” — if they’re missing, re-open the character to
            re-record ownership.
          </p>
        )}

        {/* From a video to a scene: the dialogue this recording already
            contains, re-performed by the Characters it just made. Only
            offered when the recording actually holds a transcript — the
            panel says why when it does not, rather than rendering a
            dead button. */}
        {jobId && outcome.made.length > 0 && <OpenAsScene jobId={jobId} />}

        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/voices" className="rounded-full bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110">
            Back to roster →
          </Link>
          <button onClick={startOver} className="font-jetbrains cursor-pointer rounded-full border border-white/15 px-5 py-2.5 text-sm text-white/85 transition hover:bg-white/5">
            Scan another recording
          </button>
        </div>
      </div>
    </div>
  );
}
