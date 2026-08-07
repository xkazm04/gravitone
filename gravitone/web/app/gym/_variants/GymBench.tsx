"use client";

// GymBench — "the bench": the gym as a certification instrument. The mental
// model is `python -m service.certify` output rendered in obsidian glass —
// a ledger table of recordings, a mono run header per artifact, want/got check
// rows. Dense, mono-heavy, data-first; the one accent is cyan on the selected
// row and the running state. What makes this variant different: it reads like
// an engineer's lab notebook, not a dashboard — zero decoration, zero pictures.

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

import { Button, Panel } from "@/components/ui/Primitives";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { rise } from "@/components/ui/tokens";

import type { RecordingSummary } from "../_gym/types";
import { fmtClock, fmtS, useGymRuns, useGymSetup, type SessionRun } from "../_gym/data";
import {
  ChecksTable,
  DriftNote,
  GymEmpty,
  ReplayKnobs,
  RunTotals,
  Verdict,
} from "../_gym/shared";

const LABEL = "font-jetbrains text-[11px] uppercase tracking-[0.18em] text-white/45";

/** Wall-clock since the replay started. Text, not animation — the interval is
 *  cleaned up on unmount, and the component only exists while running. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return (
    <span className="font-jetbrains text-[13px] tabular-nums text-cyan-200">
      {mm}:{ss}
    </span>
  );
}

/** One recording, one ledger row. in_progress rows are honest about why they
 *  cannot be replayed rather than silently unselectable. */
function RecordingRow({
  rec,
  selected,
  disabled,
  onSelect,
}: {
  rec: RecordingSummary;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const running = rec.status === "in_progress";
  const rowDisabled = running || disabled;
  return (
    <tr
      className={`border-t border-white/5 transition ${
        selected ? "bg-cyan-400/5" : running ? "opacity-50" : "hover:bg-white/[0.02]"
      }`}
    >
      <td className="px-3 py-2">
        <input
          type="radio"
          name="bench-recording"
          checked={selected}
          disabled={rowDisabled}
          onChange={onSelect}
          aria-label={`select ${rec.conversation_id}`}
          className="accent-cyan-300"
        />
      </td>
      <td className="font-jetbrains max-w-[16rem] truncate px-3 py-2 text-[12px] text-white/85">
        {rec.conversation_id}
      </td>
      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{rec.agent_id ?? "—"}</td>
      <td className="font-jetbrains px-3 py-2 text-right text-[12px] tabular-nums text-white/60">
        {rec.turns ?? "—"}
      </td>
      <td className="font-jetbrains px-3 py-2 text-right text-[12px] tabular-nums text-white/60">
        {rec.duration_s !== undefined ? fmtS(rec.duration_s) : "—"}
      </td>
      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">
        {fmtClock(rec.recorded_at)}
      </td>
      <td className="px-3 py-2">
        {running ? (
          <span className="font-jetbrains text-[11px] text-amber-200/90">call still running</span>
        ) : (
          <span className="font-jetbrains text-[11px] text-emerald-300/80">complete</span>
        )}
      </td>
    </tr>
  );
}

/** One run artifact: mono header line, totals, and (when scored) the checks. */
function RunCard({
  entry,
  index,
  isBaseline,
}: {
  entry: SessionRun;
  index: number;
  isBaseline: boolean;
}) {
  const { run, comparison } = entry;
  const wireTimed = run.timings_source === "wire";
  return (
    <motion.div variants={rise} initial="hidden" animate="show" custom={index}>
      <Panel className="p-5">
        <div className="font-jetbrains flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
          <span className="text-white/85">{run.run_id}</span>
          <span className="text-white/45">{run.source_name}</span>
          <span className="text-white/45">brain {run.brain.backend ?? "—"}</span>
          <span className="text-white/45">
            pace {run.wire.realtime ? "1 real-time" : "0 fast"}
          </span>
          <span className="text-white/45">{run.wire.polite ? "polite" : "barge-in"}</span>
          <span className={wireTimed ? "text-amber-200/90" : "text-white/45"}>
            timings {run.timings_source}
          </span>
        </div>
        {wireTimed && (
          <p className="font-jetbrains mt-1 text-[11px] text-amber-200/90">
            client-observed timings only; server costs unknown
          </p>
        )}

        <div className="mt-4">
          <RunTotals run={run} />
        </div>

        {comparison ? (
          <div className="mt-4 rounded-xl border border-white/8 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className={LABEL}>vs previous run</span>
              <Verdict verdict={comparison.verdict} />
            </div>
            <div className="mt-2">
              <ChecksTable checks={comparison.checks} />
            </div>
          </div>
        ) : isBaseline ? (
          <p className="font-hanken mt-4 text-[13px] text-slate-400">
            baseline — run again to compare
          </p>
        ) : (
          <p className="font-hanken mt-4 text-[13px] text-slate-400">not scored</p>
        )}
      </Panel>
    </motion.div>
  );
}

export default function GymBench() {
  const { recordings, loading, error, refresh } = useGymSetup();
  const { runs, byRecording, state, replay, dismissError } = useGymRuns();

  const [selected, setSelected] = useState<string | null>(null);
  const [pace, setPace] = useState(1);
  const [polite, setPolite] = useState(true);

  const running = state.phase === "running";
  const conversations = recordings?.conversations ?? [];
  const selectedRec = conversations.find((r) => r.conversation_id === selected) ?? null;
  const canRun = !running && selectedRec !== null && selectedRec.status === "complete";

  if (loading) {
    return (
      <p className="font-jetbrains text-[12px] uppercase tracking-[0.18em] text-white/45">
        loading the bench…
      </p>
    );
  }

  if (error) {
    return (
      <div>
        <ErrorBanner className="mt-0">{error}</ErrorBanner>
        <Button variant="ghost" className="mt-4" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div>
      {/* ── control strip: the recording ledger ────────────────────────── */}
      <Panel className="p-5">
        <div className={LABEL}>recorded conversations</div>

        {recordings && conversations.length === 0 ? (
          <GymEmpty recordingOn={recordings.recording} directory={recordings.directory} />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr>
                  <th className="w-8 px-3 py-2" aria-label="select" />
                  <th className={`${LABEL} px-3 py-2 font-normal`}>recording</th>
                  <th className={`${LABEL} px-3 py-2 font-normal`}>agent</th>
                  <th className={`${LABEL} px-3 py-2 text-right font-normal`}>turns</th>
                  <th className={`${LABEL} px-3 py-2 text-right font-normal`}>duration</th>
                  <th className={`${LABEL} px-3 py-2 font-normal`}>recorded</th>
                  <th className={`${LABEL} px-3 py-2 font-normal`}>status</th>
                </tr>
              </thead>
              <tbody>
                {conversations.map((rec) => (
                  <RecordingRow
                    key={rec.conversation_id}
                    rec={rec}
                    selected={selected === rec.conversation_id}
                    disabled={running}
                    onSelect={() => setSelected(rec.conversation_id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {conversations.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-white/5 pt-4">
            <ReplayKnobs
              pace={pace}
              polite={polite}
              onPace={setPace}
              onPolite={setPolite}
              disabled={running}
            />
            {running && state.phase === "running" ? (
              <div className="flex items-center gap-3">
                <Elapsed startedAt={state.startedAt} />
                <span className="font-hanken text-[13px] text-slate-400">
                  replaying {state.recording}… a real-time replay takes as long as the call did
                </span>
              </div>
            ) : (
              <Button
                disabled={!canRun}
                onClick={() => {
                  if (selected) void replay(selected, { pace, polite });
                }}
              >
                Run replay
              </Button>
            )}
          </div>
        )}

        {state.phase === "error" && (
          <ErrorBanner>
            {state.message}{" "}
            <button
              type="button"
              onClick={dismissError}
              className="font-jetbrains ml-2 underline decoration-rose-300/40 underline-offset-2 hover:text-rose-100"
            >
              dismiss
            </button>
          </ErrorBanner>
        )}
      </Panel>

      {/* ── runs ledger: this session's artifacts, newest first ────────── */}
      {runs.length > 0 && (
        <section className="mt-8">
          <div className={LABEL}>session runs</div>
          <div className="mt-3 space-y-4">
            {runs.map((entry, i) => {
              const siblings = byRecording.get(entry.run.source_name) ?? [];
              // runs are newest-first, so the LAST sibling is the recording's
              // first run of the session — the baseline nothing scores against.
              const isBaseline = siblings[siblings.length - 1] === entry;
              return (
                <RunCard
                  key={entry.run.run_id}
                  entry={entry}
                  index={i}
                  isBaseline={isBaseline}
                />
              );
            })}
          </div>
          <DriftNote className="mt-4" />
        </section>
      )}
    </div>
  );
}
