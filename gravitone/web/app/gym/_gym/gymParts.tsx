"use client";

// Sub-components every gym variant renders the same way, hoisted on day one so
// three prototypes never grow three dialects of a check row or a verdict.
// Styling discipline: Obsidian tokens/primitives only, emerald = pass,
// rose = fail (ErrorBanner's severity contract), amber = caveat.

import type { ReactNode } from "react";

import type { GymCheck, GymRun } from "./types";
import { fmtS, fmtWer } from "./data";

/** PASS / FAIL stamp — the compare verdict, certify.py's convention in glass. */
export function Verdict({ verdict, className = "" }: { verdict: "pass" | "fail"; className?: string }) {
  const pass = verdict === "pass";
  return (
    <span
      className={`font-jetbrains inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.18em] ${
        pass
          ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-300"
          : "border-rose-400/30 bg-rose-400/5 text-rose-300"
      } ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${pass ? "bg-emerald-300" : "bg-rose-300"}`} />
      {pass ? "pass" : "fail"}
    </span>
  );
}

/** One measured number with its label. A null renders as an em dash — the
 *  load-bearing "absent is absent" convention from /ops. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-white/45">
        {label}
      </div>
      <div className="font-jetbrains mt-1 text-base text-white" title={hint}>
        {value}
      </div>
    </div>
  );
}

/** The named checks of a comparison (or a suite case), want/got/pass rows. */
export function ChecksTable({ checks }: { checks: GymCheck[] }) {
  return (
    <ul className="divide-y divide-white/5">
      {checks.map((c) => (
        <li key={c.check} className="flex items-baseline gap-3 py-2">
          <span
            className={`font-jetbrains w-10 shrink-0 text-[11px] uppercase tracking-widest ${
              c.pass ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {c.pass ? "pass" : "fail"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-jetbrains text-[12px] text-white/85">{c.check}</div>
            <div className="font-hanken mt-0.5 text-[13px] text-slate-400">
              want {c.want} · got <span className="text-slate-200">{String(c.got)}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The run's headline numbers, one row, shared grammar across variants. */
export function RunTotals({ run }: { run: GymRun }) {
  const t = run.totals;
  return (
    <div className="grid grid-cols-3 gap-4 sm:grid-cols-6">
      <Stat label="turns" value={`${t.candidate_turns}·${t.agent_turns}`} hint="caller · agent" />
      <Stat
        label="interruptions"
        value={t.interruptions}
      />
      <Stat label="answer p50" value={fmtS(t.answer_s.p50)} hint={`mean ${fmtS(t.answer_s.mean)} · max ${fmtS(t.answer_s.max)}`} />
      <Stat
        label="transcribe p50"
        value={fmtS(t.transcribe_s.p50)}
        hint={`mean ${fmtS(t.transcribe_s.mean)} · max ${fmtS(t.transcribe_s.max)}`}
      />
      <Stat
        label="drift vs source"
        value={run.drift_vs_source.available ? fmtWer(run.drift_vs_source.wer) : "—"}
        hint={run.drift_vs_source.note}
      />
      <Stat label="wall" value={fmtS(t.wall_s)} />
    </div>
  );
}

/** The one line that keeps a WER number honest, wherever drift is shown. */
export function DriftNote({ className = "" }: { className?: string }) {
  return (
    <p className={`font-hanken text-[12px] text-slate-500 ${className}`}>
      Drift is WER against an ASR-produced reference — the ear changed, not the truth.
    </p>
  );
}

/** Pace + politeness, the two knobs a replay has. Semantics stated inline
 *  because they decide what the numbers MEAN, not how they look. */
export function ReplayKnobs({
  pace,
  polite,
  onPace,
  onPolite,
  disabled,
}: {
  pace: number;
  polite: boolean;
  onPace: (v: number) => void;
  onPolite: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <Knob
        label="pace"
        options={[
          { value: "0", title: "fast — same turns, no wall-clock wait" },
          { value: "1", title: "real time — what a latency claim needs" },
        ]}
        labels={["fast", "real-time"]}
        active={pace >= 1 ? "1" : "0"}
        onPick={(v) => onPace(Number(v))}
        disabled={disabled}
      />
      <Knob
        label="floor"
        options={[
          { value: "polite", title: "wait out the agent's replies, as the caller did" },
          { value: "barge-in", title: "talk over the agent on purpose" },
        ]}
        labels={["polite", "barge-in"]}
        active={polite ? "polite" : "barge-in"}
        onPick={(v) => onPolite(v === "polite")}
        disabled={disabled}
      />
    </div>
  );
}

function Knob({
  label,
  options,
  labels,
  active,
  onPick,
  disabled,
}: {
  label: string;
  options: { value: string; title: string }[];
  labels: string[];
  active: string;
  onPick: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-white/45">
        {label}
      </span>
      <div className="flex overflow-hidden rounded-full border border-white/15">
        {options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            title={o.title}
            disabled={disabled}
            onClick={() => onPick(o.value)}
            className={`font-jetbrains px-3 py-1 text-[11px] transition disabled:opacity-50 ${
              active === o.value ? "bg-cyan-400/15 text-cyan-200" : "text-white/60 hover:text-white"
            }`}
          >
            {labels[i]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The honest empty states: recording off is a WHY, not "no conversations". */
export function GymEmpty({
  recordingOn,
  directory,
}: {
  recordingOn: boolean;
  directory: string;
}) {
  return (
    <div className="py-10 text-center">
      <p className="font-hanken text-base text-slate-300">
        {recordingOn
          ? "No recorded conversations yet. Hold a conversation with an agent and it will appear here."
          : "Recording is off, so there is nothing to replay."}
      </p>
      <p className="font-jetbrains mt-3 text-[12px] text-white/45">
        {recordingOn ? (
          <>recordings land in {directory}</>
        ) : (
          <>
            start the service with <span className="text-cyan-300">CONVAI_RECORD=1</span> and hold a
            call — every conversation then leaves a replayable recording
          </>
        )}
      </p>
    </div>
  );
}
