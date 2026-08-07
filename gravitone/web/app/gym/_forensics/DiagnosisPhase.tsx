"use client";

// Phase 2 — the two-lens board. Internal findings are honestly absent in
// round 1 (see diagnose.ts::INTERNAL_LENS_LIMIT — the ear is the instrument);
// external findings are grouped by rule so the developers who own the brain
// read indications, not a scroll of rows.

import { motion } from "framer-motion";

import { rise } from "@/components/ui/tokens";

import type { SessionRow } from "../_gym/data";
import { INTERNAL_LENS_LIMIT, type Finding } from "../_gym/diagnose";

const KIND_ORDER = [
  "barge-in",
  "slow-answer",
  "leaked-markup",
  "monologue",
  "slow-ear",
  "one-sided",
] as const;

const LABEL = "font-jetbrains text-[11px] uppercase tracking-[0.18em]";

function severityChip(severity: Finding["severity"]) {
  return severity === "concern"
    ? "border-rose-400/30 text-rose-300"
    : "border-amber-400/25 text-amber-200";
}

export default function DiagnosisPhase({
  sessions,
  onInspect,
}: {
  sessions: SessionRow[];
  onInspect: (sessionId: string, seekS?: number) => void;
}) {
  const readable = sessions.filter((s) => s.transcript !== null);
  if (readable.length === 0) {
    return (
      <p className="font-hanken text-base text-slate-400">
        Nothing to diagnose yet — sessions appear here once a recorded conversation has a
        readable transcript.
      </p>
    );
  }

  // Internal lens: per-character listening queue, most recent session first.
  const byCharacter = new Map<string, SessionRow[]>();
  for (const s of readable) {
    const name = s.character?.name ?? s.voiceId ?? "unassigned";
    byCharacter.set(name, [...(byCharacter.get(name) ?? []), s]);
  }

  // External lens: every finding, grouped by rule kind in a stable order.
  const external = readable.flatMap((s) => s.findings.filter((f) => f.lens === "external"));
  const byKind = new Map<string, Finding[]>();
  for (const kind of KIND_ORDER) {
    const group = external.filter((f) => f.kind === kind);
    if (group.length) byKind.set(kind, group);
  }

  return (
    <motion.div
      variants={rise}
      initial="hidden"
      animate="show"
      className="grid gap-6 md:grid-cols-2"
    >
      <section>
        <h3 className={`${LABEL} text-white/60`}>internal — the character</h3>
        <p className="font-hanken mt-1 text-[13px] text-slate-400">
          What the Character&rsquo;s voice needs from this studio.
        </p>
        <p className="font-hanken mt-4 rounded-lg border border-dashed border-white/10 p-4 text-[13px] text-slate-400">
          {INTERNAL_LENS_LIMIT}
        </p>
        <ul className="mt-4 space-y-2">
          {[...byCharacter.entries()].map(([name, rows]) => {
            const newest = [...rows].sort(
              (a, b) => b.recording.recorded_at - a.recording.recorded_at,
            )[0];
            return (
              <li key={name} className="flex items-baseline gap-2">
                <span className="font-hanken text-[14px] text-slate-200">{name}</span>
                <span className="font-jetbrains text-[11px] text-white/45">
                  — {rows.length} session{rows.length === 1 ? "" : "s"} ·
                </span>
                <button
                  type="button"
                  onClick={() => onInspect(newest.recording.conversation_id)}
                  className="font-jetbrains text-[11px] text-cyan-300 hover:underline"
                >
                  listen
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h3 className={`${LABEL} text-white/60`}>external — their pipeline</h3>
        <p className="font-hanken mt-1 text-[13px] text-slate-400">
          Indications for the developers who own the brain. Their pipeline, their debugging.
        </p>
        {byKind.size === 0 ? (
          <div className="mt-4 flex items-center gap-3">
            <span
              className={`${LABEL} rounded-full border border-emerald-400/30 px-2.5 py-0.5 text-emerald-300/80`}
            >
              clean
            </span>
            <p className="font-hanken text-[13px] text-slate-400">
              No external indications in the recorded sessions.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            {[...byKind.entries()].map(([kind, findings]) => {
              const worst = findings.some((f) => f.severity === "concern")
                ? "concern"
                : "notice";
              return (
                <div key={kind}>
                  <div className="flex items-center gap-2">
                    <span
                      className={`${LABEL} rounded-full border border-white/15 px-2.5 py-0.5 text-white/70`}
                    >
                      {kind}
                    </span>
                    <span className="font-jetbrains text-[11px] text-white/45">
                      ×{findings.length}
                    </span>
                    <span
                      className={`${LABEL} rounded-full border px-2.5 py-0.5 ${severityChip(worst)}`}
                    >
                      {worst}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-2">
                    {findings.map((f) => (
                      <li key={f.id} className="flex items-baseline gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-hanken text-[14px] text-slate-200">{f.summary}</p>
                          <p className="font-jetbrains text-[11px] text-white/45">
                            {f.evidence} · {f.session.slice(0, 8)}
                            {typeof f.turn === "number" ? ` · turn ${f.turn}` : ""}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => onInspect(f.session, f.at_s)}
                          className="font-jetbrains shrink-0 text-[11px] text-cyan-300 hover:underline"
                        >
                          view →
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </motion.div>
  );
}
