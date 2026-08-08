"use client";

// Pieces both studio variants render identically — hoisted on day one so the
// directions differ in mental model, not in how a measured fact is drawn.

import { useEffect, useState } from "react";
import { loadRoster, type Character } from "@/app/voices/_data/characters";
import { fitVerdict, type RevoiceFit, type StudioJob, type VoiceoverFit } from "./data";

/** The roster, once per mount, with the failure surfaced. */
export function useRoster() {
  const [roster, setRoster] = useState<Character[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    loadRoster(ctrl.signal)
      .then((cs) => setRoster(cs.filter((c) => c.voices.length > 0)))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted)
          setError(e instanceof Error ? e.message : "failed to load characters");
      });
    return () => ctrl.abort();
  }, []);
  return { roster, rosterError: error };
}

/** One fit meter, drawn TO SCALE: the hairline track is the slot's budget,
 *  the bar is what was actually spoken. Overrun paints amber past the end —
 *  the picture says "spills" before the label does. */
export function FitMeter({ fit }: { fit: VoiceoverFit | RevoiceFit }) {
  const budget = fit.budget_seconds ?? 0;
  const spoken = ("seconds" in fit ? fit.seconds : null) ?? 0;
  const verdict = fitVerdict(fit);
  if (!budget) return <span className="font-jetbrains text-[11px] text-white/45">{verdict.label}</span>;
  const scale = Math.max(budget, spoken);
  const budgetPct = (budget / scale) * 100;
  const spokenPct = (spoken / scale) * 100;
  const over = spoken > budget;
  const barColor =
    verdict.tone === "error" ? "bg-rose-400/80"
    : verdict.tone === "warn" ? "bg-amber-300/80"
    : verdict.tone === "muted" ? "bg-white/20"
    : "bg-cyan-300/80";
  return (
    <div className="min-w-0">
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        {/* the budget's end, marked so an under-fill reads as headroom */}
        <div className="absolute inset-y-0 border-r border-white/30" style={{ width: `${budgetPct}%` }} />
        <div className={`absolute inset-y-0 left-0 rounded-full ${barColor}`} style={{ width: `${spokenPct}%` }} />
        {over && (
          <div
            className="absolute inset-y-0 bg-amber-300/40"
            style={{ left: `${budgetPct}%`, width: `${spokenPct - budgetPct}%` }}
          />
        )}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className={`font-jetbrains text-[11px] ${
          verdict.tone === "error" ? "text-rose-300"
          : verdict.tone === "warn" ? "text-amber-200"
          : verdict.tone === "muted" ? "text-white/45" : "text-cyan-200"
        }`}>
          {verdict.label}
        </span>
        <span className="font-jetbrains text-[11px] text-white/45">
          {spoken ? `${spoken.toFixed(1)}s` : "—"} / {budget.toFixed(1)}s
        </span>
      </div>
    </div>
  );
}

/** The job's pipeline, one line per step, from the server's own labels. */
export function StepsRail({ job, stalled }: { job: StudioJob; stalled: boolean }) {
  return (
    <div>
      <ol className="space-y-2">
        {job.steps.map((s) => (
          <li key={s.key} className="flex items-center gap-3">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                s.state === "done" ? "bg-cyan-300"
                : s.state === "active" ? "bg-cyan-300/90 shadow-[0_0_8px_var(--gt-glow-cyan)]"
                : "bg-white/15"
              }`}
            />
            <span className={`font-jetbrains text-[12px] uppercase tracking-[0.14em] ${
              s.state === "active" ? "text-white" : s.state === "done" ? "text-white/60" : "text-white/30"
            }`}>
              {s.label}
            </span>
            {s.state === "active" && <ProgressNote job={job} step={s.key} />}
          </li>
        ))}
      </ol>
      {stalled && (
        <p className="font-hanken mt-3 text-sm text-amber-200">
          connection degraded — the job keeps running on the box; this page will catch up
        </p>
      )}
    </div>
  );
}

function ProgressNote({ job, step }: { job: StudioJob; step: string }) {
  const p = job.partial;
  let note: string | null = null;
  if (step === "scenes" && p.scenes) note = `${p.scenes} scenes`;
  if (step === "look" && p.described != null) note = `${p.described}/${p.scenes ?? "?"} described`;
  if (step === "write" && p.words) note = `${p.lines ?? 0} lines · ${p.words} words`;
  if (step === "speak" && p.spoken_total)
    note = `${Math.min((p.spoken_done ?? 0) + 1, p.spoken_total)}/${p.spoken_total}`;
  if (!note) return null;
  return <span className="font-jetbrains text-[11px] text-white/45">{note}</span>;
}

/** Character picker, data-concrete: name, language, emotion coverage. */
export function CharacterSelect({
  roster, value, onChange, id,
}: {
  roster: Character[] | null;
  value: string;
  onChange: (id: string) => void;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="font-hanken w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
    >
      <option value="" disabled>
        {roster === null ? "loading characters…" : roster.length ? "choose a character" : "no cloned characters yet"}
      </option>
      {(roster ?? []).map((c) => (
        <option key={c.character_id} value={c.character_id}>
          {c.name} · {c.lang || "en"} · {c.coverage}/{c.total} emotions
        </option>
      ))}
    </select>
  );
}

/** Timecode as an editor says it: m:ss.s */
export function tc(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
