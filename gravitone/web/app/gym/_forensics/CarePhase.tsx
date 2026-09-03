"use client";

// Phase 3 — actions. Internal care routes back into the studio (retrain the
// Character); external findings leave as a report, because diagnosis of the
// brain/pipeline belongs to the developers who own it.

import { useMemo } from "react";
import Link from "next/link";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/Primitives";
import { rise } from "@/components/ui/tokens";
import { useCopyFeedback } from "@/lib/useCopyFeedback";

import type { SessionRow } from "../_gym/data";

const LABEL = "font-jetbrains text-[11px] uppercase tracking-[0.18em]";
const CARD = "border border-white/10 rounded-xl p-5";

export default function CarePhase({ sessions }: { sessions: SessionRow[] }) {
  const { copy, copied, failed } = useCopyFeedback();

  // Distinct characters across sessions, with how many sessions each carries.
  const characters = useMemo(() => {
    const map = new Map<string, { name: string; count: number }>();
    for (const s of sessions) {
      if (!s.character) continue;
      const entry = map.get(s.character.character_id);
      if (entry) entry.count += 1;
      else map.set(s.character.character_id, { name: s.character.name, count: 1 });
    }
    return [...map.entries()];
  }, [sessions]);

  // The handover payload: external findings only, per session, as indications.
  const report = useMemo(() => {
    const rows = sessions
      .map((s) => ({
        session: s.recording.conversation_id,
        agent_id: s.recording.agent_id ?? null,
        recorded_at: s.recording.recorded_at,
        findings: s.findings
          .filter((f) => f.lens === "external")
          .map((f) => ({
            kind: f.kind,
            severity: f.severity,
            turn: f.turn ?? null,
            at_s: f.at_s ?? null,
            summary: f.summary,
            evidence: f.evidence,
          })),
      }))
      .filter((row) => row.findings.length > 0);
    if (rows.length === 0) return null;
    return JSON.stringify(
      {
        generated_for: "external pipeline developers",
        note: "Indications observed in recorded conversations against this deployment's agents. Diagnosis of the brain/pipeline is yours.",
        sessions: rows,
      },
      null,
      2,
    );
  }, [sessions]);

  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "gravitone-findings.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <motion.div
      variants={rise}
      initial="hidden"
      animate="show"
      className="grid gap-6 md:grid-cols-2"
    >
      <section className={CARD}>
        <h3 className={`${LABEL} text-white/60`}>Retrain in the studio</h3>
        {characters.length === 0 ? (
          <p className="font-hanken mt-4 text-[13px] text-slate-400">
            No sessions are wired to a Character yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {characters.map(([id, { name, count }]) => (
              <li key={id} className="flex flex-wrap items-center gap-3">
                <span className="font-hanken text-[14px] text-slate-200">{name}</span>
                <span className="font-jetbrains text-[11px] text-white/45">
                  {count} session{count === 1 ? "" : "s"}
                </span>
                <Link
                  href={`/voices/new?extend=${id}`}
                  className="font-jetbrains rounded-full border border-white/15 px-4 py-1.5 text-[12px] text-white/85 hover:bg-white/5"
                >
                  Extend this character →
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="font-hanken mt-4 text-[13px] text-slate-400">
          Retraining starts from a new recording — the studio preselects the Character.
        </p>
      </section>

      <section className={CARD}>
        <h3 className={`${LABEL} text-white/60`}>Hand the findings over</h3>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={download} disabled={!report} className="px-5 py-2 text-[13px]">
            Download findings report
          </Button>
          <Button
            variant="ghost"
            onClick={() => report && void copy(report)}
            disabled={!report}
            className="px-5 py-2 text-[12px]"
          >
            {failed ? "copy blocked" : copied ? "✓ copied" : "Copy as JSON"}
          </Button>
          {!report && (
            <span className="font-jetbrains text-[11px] text-white/45">
              no external findings yet
            </span>
          )}
        </div>
        <p className="font-hanken mt-4 text-[13px] text-slate-400">
          A JSON report of every external indication, per session — evidence and seek targets
          included, fixes deliberately not.
        </p>
      </section>
    </motion.div>
  );
}
