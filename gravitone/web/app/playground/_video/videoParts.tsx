"use client";

// Pieces every video extension of the console draws the same way. Hoisted on
// day one so the two directions differ in WHERE the picture lives, never in
// how a measured fact is rendered.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { fitVerdict, type RevoiceFit, type StudioJob, type VoiceoverFit } from "./videoData";

/** One fit meter, drawn TO SCALE: the hairline track is the slot's budget, the
 *  bar is what was actually spoken, and an overrun paints amber PAST the
 *  budget mark — the picture says "spills" before the label does. */
export function FitMeter({ fit, compact = false }: {
  fit: VoiceoverFit | RevoiceFit;
  compact?: boolean;
}) {
  const budget = fit.budget_seconds ?? 0;
  const spoken = ("seconds" in fit ? fit.seconds : null) ?? 0;
  const verdict = fitVerdict(fit);
  if (!budget) {
    return <span className="font-jetbrains text-[11px] text-white/50">{verdict.label}</span>;
  }
  const scale = Math.max(budget, spoken);
  const budgetPct = (budget / scale) * 100;
  const spokenPct = (spoken / scale) * 100;
  const over = spoken > budget;
  const bar =
    verdict.tone === "error" ? "bg-rose-400/80"
    : verdict.tone === "warn" ? "bg-amber-300/80"
    : verdict.tone === "muted" ? "bg-white/25"
    : "bg-cyan-300/80";
  const ink =
    verdict.tone === "error" ? "text-rose-300"
    : verdict.tone === "warn" ? "text-amber-200"
    : verdict.tone === "muted" ? "text-white/50" : "text-cyan-200";
  return (
    <div className="min-w-0">
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
        <div className="absolute inset-y-0 border-r border-white/30" style={{ width: `${budgetPct}%` }} />
        <div className={`absolute inset-y-0 left-0 rounded-full ${bar}`} style={{ width: `${spokenPct}%` }} />
        {over && (
          <div className="absolute inset-y-0 bg-amber-300/40"
               style={{ left: `${budgetPct}%`, width: `${spokenPct - budgetPct}%` }} />
        )}
      </div>
      {!compact && (
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className={`font-jetbrains text-[11px] ${ink}`}>{verdict.label}</span>
          <span className="font-jetbrains text-[11px] text-white/50">
            {spoken ? `${spoken.toFixed(1)}s` : "—"} / {budget.toFixed(1)}s
          </span>
        </div>
      )}
    </div>
  );
}

/** The job's pipeline, from the SERVER's own step labels — never re-authored
 *  here, so a backend that renames a phase cannot leave this lying. */
export function StepsRail({ job, stalled }: { job: StudioJob; stalled: boolean }) {
  return (
    <div>
      <ol className="space-y-2">
        {job.steps.map((s) => (
          <li key={s.key} className="flex items-center gap-3">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              s.state === "done" ? "bg-cyan-300"
              : s.state === "active" ? "bg-cyan-300/90 shadow-[0_0_8px_var(--gt-glow-cyan)]"
              : "bg-white/15"
            }`} />
            <span className={`font-jetbrains text-[11px] uppercase tracking-widest ${
              s.state === "active" ? "text-white" : s.state === "done" ? "text-white/60" : "text-white/35"
            }`}>
              {s.label}
            </span>
            {s.state === "active" && <ProgressNote job={job} step={s.key} />}
          </li>
        ))}
      </ol>
      {/* a degraded CONNECTION is a warning, not a failure: the job itself is
          fine, only our view of it is behind. Severity is the banner's job. */}
      {stalled && (
        <ErrorBanner severity="warning" className="mt-3">
          connection degraded — the job keeps running on the box; this page will catch up
        </ErrorBanner>
      )}
    </div>
  );
}

function ProgressNote({ job, step }: { job: StudioJob; step: string }) {
  const p = job.partial;
  let note: string | null = null;
  // The source's own facts, KEPT rather than dropped: during fetch there is
  // nothing else on screen, and "3:20 · 1920×1080" is how a user tells at a
  // glance that the box got the video they meant — and how long they are in
  // for. `frames` earns its place next to `scenes` because a scene whose frame
  // was never captured is narrated blind, and the shortfall shows here first.
  if (step === "fetch" && p.video) {
    note = `${tc(p.video.seconds)} · ${p.video.width}×${p.video.height}`;
  }
  if (step === "scenes" && p.scenes) {
    note = p.frames != null && p.frames !== p.scenes
      ? `${p.scenes} scenes · ${p.frames} frames`
      : `${p.scenes} scenes`;
  }
  // The box does not buy a description twice for the same shot: a scene that
  // repeats its predecessor INHERITS one. Both are described, but only
  // `looked_at` were actually shown to the model, and a rail that folded the
  // two together would report an observation that never happened.
  if (step === "look" && p.described != null) {
    const inherited = p.looked_at != null ? p.described - p.looked_at : 0;
    note = inherited > 0
      ? `${p.described}/${p.scenes ?? "?"} described · ${inherited} the same shot`
      : `${p.described}/${p.scenes ?? "?"} described`;
  }
  if (step === "write" && p.words) note = `${p.lines ?? 0} lines · ${p.words} words`;
  if (step === "speak" && p.spoken_total) {
    note = `${Math.min((p.spoken_done ?? 0) + 1, p.spoken_total)}/${p.spoken_total}`;
  }
  if (!note) return null;
  return <span className="font-jetbrains text-[11px] text-white/50">{note}</span>;
}

/** Timecode as an editor says it: m:ss.s */
export function tc(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
