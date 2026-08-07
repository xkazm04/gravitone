"use client";

// GymLadder — "the ladder": the gym as level-by-level certification. A static
// hairline rail with one node per level (StepRail's grammar: done settles to
// emerald, the active step takes the cyan accent, the locked route is dashed);
// each level unlocks when the previous one produced its artifact — run, then
// comparison, then the CI suite handoff. Derived purely from useGymRuns state:
// no state machine of its own, no fetch dialect of its own.

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Panel } from "@/components/ui/Primitives";
import { rise } from "@/components/ui/tokens";
import { useCopyFeedback } from "@/lib/useCopyFeedback";

import {
  fmtClock,
  fmtS,
  useGymRuns,
  useGymSetup,
  type SessionRun,
} from "../_gym/data";
import {
  ChecksTable,
  DriftNote,
  GymEmpty,
  ReplayKnobs,
  RunTotals,
  Verdict,
} from "../_gym/shared";
import type { RecordingSummary } from "../_gym/types";

type LevelState = "locked" | "active" | "done";

const LABEL = "font-jetbrains text-[11px] uppercase tracking-[0.18em] text-white/45";

/** Elapsed seconds since `since`, ticking only while `on`. A timer, not an
 *  animation — it reports a real measurement in flight. */
function useElapsed(on: boolean, since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [on]);
  if (!on || since === null) return "";
  return ((now - since) / 1000).toFixed(1);
}

function LevelNode({ state, index }: { state: LevelState; index: number }) {
  const ring =
    state === "done"
      ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-300"
      : state === "active"
        ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-200"
        : "border-dashed border-white/20 bg-transparent text-white/35";
  return (
    <div
      className={`relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full border transition-colors duration-500 ${ring}`}
      aria-hidden
    >
      <span className="font-jetbrains text-[11px]">{state === "done" ? "✓" : index}</span>
    </div>
  );
}

function LevelShell({
  index,
  title,
  state,
  children,
}: {
  index: number;
  title: string;
  state: LevelState;
  children: React.ReactNode;
}) {
  const locked = state === "locked";
  return (
    <motion.li variants={rise} custom={index} className="relative flex gap-5">
      <LevelNode state={state} index={index} />
      <Panel
        className={`min-w-0 flex-1 p-5 transition-opacity duration-500 ${
          locked ? "border-dashed opacity-60" : ""
        }`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className={LABEL}>level {index}</span>
          <h2 className="font-instrument text-xl text-white">{title}</h2>
          {state === "done" && (
            <span className="font-jetbrains ml-auto rounded-full border border-emerald-400/30 bg-emerald-400/5 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-emerald-300">
              artifact produced
            </span>
          )}
          {locked && (
            <span className="font-jetbrains ml-auto text-[11px] uppercase tracking-[0.18em] text-white/45">
              locked
            </span>
          )}
        </div>
        {children}
      </Panel>
    </motion.li>
  );
}

function CopyButton({
  text,
  copied,
  failed,
  onCopy,
}: {
  text: string;
  copied: boolean;
  failed: boolean;
  onCopy: (text: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCopy(text)}
      className={`font-jetbrains rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.18em] transition ${
        failed
          ? "border-rose-400/30 text-rose-300"
          : copied
            ? "border-emerald-400/30 text-emerald-300"
            : "border-white/15 text-white/60 hover:text-white"
      }`}
    >
      {failed ? "copy blocked" : copied ? "✓ copied" : "copy"}
    </button>
  );
}

export default function GymLadder() {
  const { recordings, loading, error, refresh } = useGymSetup();
  const { byRecording, state, replay, dismissError } = useGymRuns();

  const [picked, setPicked] = useState<string | null>(null);
  const [pace, setPace] = useState(0);
  const [polite, setPolite] = useState(true);
  const { copy, copied, failed } = useCopyFeedback<"seed" | "cmds">();

  const conversations = recordings?.conversations ?? [];
  const selectedId =
    picked ?? conversations.find((c) => c.status === "complete")?.conversation_id ?? null;

  const selRuns: SessionRun[] = useMemo(
    () => (selectedId ? (byRecording.get(selectedId) ?? []) : []),
    [byRecording, selectedId],
  );
  const latest = selRuns[0] ?? null;
  const scored = useMemo(() => selRuns.find((r) => r.comparison !== null) ?? null, [selRuns]);

  const l1: LevelState = latest ? "done" : "active";
  const l2: LevelState = !latest ? "locked" : latest.comparison ? "done" : "active";
  const l3: LevelState = scored ? "active" : "locked";

  const running = state.phase === "running";
  const elapsed = useElapsed(running, state.phase === "running" ? state.startedAt : null);

  const run = () => {
    if (selectedId) void replay(selectedId, { pace, polite });
  };

  if (loading) {
    return <p className="font-jetbrains mt-2 text-[12px] text-white/45">loading…</p>;
  }
  if (error) {
    return (
      <div>
        <ErrorBanner className="mt-2">{error}</ErrorBanner>
        <Button variant="ghost" className="mt-4 px-4 py-2 text-[12px]" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  const seed =
    scored && latest
      ? JSON.stringify(
          {
            thresholds: latest.comparison?.thresholds ?? scored.comparison?.thresholds ?? {},
            cases: [
              {
                name: latest.run.source_name,
                recording: `recordings/${latest.run.source_name}`,
                agent_id: latest.run.agent_id,
                expect: {
                  min_turns: latest.run.totals.candidate_turns,
                  max_interruptions: latest.run.totals.interruptions,
                },
              },
            ],
          },
          null,
          2,
        )
      : "";
  const cmds =
    "python -m service.gym suite <dir> --update-baselines\npython -m service.gym suite <dir>";

  return (
    <div>
      {/* shared page furniture: replay in flight + replay failures */}
      {running && (
        <p className="font-jetbrains text-[12px] text-cyan-200" aria-live="polite">
          replaying {state.phase === "running" ? state.recording : ""} · {elapsed}s
        </p>
      )}
      {state.phase === "error" && (
        <ErrorBanner className="mb-4 mt-0">
          {state.message}
          {state.busy ? " — a replay is already running on this replica." : ""}{" "}
          <button type="button" onClick={dismissError} className="underline underline-offset-2">
            dismiss
          </button>
        </ErrorBanner>
      )}

      <motion.ol
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: {} }}
        className="relative mt-2 space-y-8"
      >
        {/* the rail — one static hairline the nodes sit on */}
        <div aria-hidden className="absolute bottom-6 left-[13px] top-6 w-px bg-white/10" />

        <LevelShell index={1} title="Replay" state={l1}>
          <p className="font-hanken mt-2 text-base text-slate-400">
            Stream a recorded call back through the socket and produce the run artifact.
          </p>
          {conversations.length === 0 && recordings ? (
            <GymEmpty recordingOn={recordings.recording} directory={recordings.directory} />
          ) : (
            <>
              <ul className="mt-4 space-y-2">
                {conversations.map((c: RecordingSummary) => {
                  const busy = c.status === "in_progress";
                  const active = c.conversation_id === selectedId;
                  return (
                    <li key={c.conversation_id}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setPicked(c.conversation_id)}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition disabled:opacity-50 ${
                          active
                            ? "border-cyan-400/40 bg-cyan-400/5"
                            : "border-white/10 hover:border-white/25"
                        }`}
                      >
                        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span
                            className={`font-jetbrains text-[12px] ${active ? "text-cyan-200" : "text-white/85"}`}
                          >
                            {c.conversation_id}
                          </span>
                          <span className="font-jetbrains text-[11px] text-white/45">
                            {c.agent_id ?? "—"} · {c.turns ?? "—"} turns ·{" "}
                            {c.duration_s !== undefined ? fmtS(c.duration_s) : "—"} ·{" "}
                            {fmtClock(c.recorded_at)}
                          </span>
                        </span>
                        {busy && (
                          <span className="font-hanken mt-1 block text-[12px] text-amber-200/90">
                            still in progress — a live call cannot be replayed yet
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
                <ReplayKnobs
                  pace={pace}
                  polite={polite}
                  onPace={setPace}
                  onPolite={setPolite}
                  disabled={running}
                />
                <Button
                  className="px-5 py-2 text-[13px]"
                  disabled={running || !selectedId}
                  onClick={run}
                >
                  Run level 1
                </Button>
              </div>
              {latest && (
                <div className="mt-5 border-t border-white/8 pt-4">
                  <RunTotals run={latest.run} />
                  <p className="font-jetbrains mt-3 text-[11px] text-white/45">
                    {latest.run.run_id} · brain {latest.run.brain.backend ?? "—"} · timings{" "}
                    {latest.run.timings_source}
                  </p>
                </div>
              )}
            </>
          )}
        </LevelShell>

        <LevelShell index={2} title="Compare" state={l2}>
          <p className="font-hanken mt-2 text-base text-slate-400">
            Run it again — the second run is scored against the first. The gym cannot tell you the
            agent is good, only whether it changed.
          </p>
          {l2 !== "locked" && (
            <div className="mt-4">
              <Button
                className="px-5 py-2 text-[13px]"
                disabled={running || !selectedId}
                onClick={run}
              >
                Run level 2
              </Button>
              {latest?.comparison ? (
                <div className="mt-5 border-t border-white/8 pt-4">
                  <Verdict verdict={latest.comparison.verdict} />
                  <div className="mt-3">
                    <ChecksTable checks={latest.comparison.checks} />
                  </div>
                  <DriftNote className="mt-2" />
                </div>
              ) : selRuns.length >= 2 ? (
                <p className="font-hanken mt-4 text-[13px] text-amber-200/90">
                  run again — this run was not scored
                </p>
              ) : null}
            </div>
          )}
        </LevelShell>

        <LevelShell index={3} title="Suite" state={l3}>
          <p className="font-hanken mt-2 text-base text-slate-400">
            Freeze this into CI: a suite is a directory of golden recordings, expectations, and
            baselines — the same replay, run by a machine on every change.
          </p>
          {l3 !== "locked" && seed && (
            <div className="mt-4 space-y-4">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <span className={LABEL}>suite.json — seeded from this session&apos;s run</span>
                  <CopyButton
                    text={seed}
                    copied={copied === "seed"}
                    failed={failed === "seed"}
                    onCopy={(t) => void copy(t, "seed")}
                  />
                </div>
                <pre className="font-jetbrains mt-2 select-all overflow-x-auto rounded-lg border border-white/10 bg-white/[0.03] p-4 text-[12px] leading-relaxed text-slate-200">
                  {seed}
                </pre>
              </div>
              <div>
                <div className="flex items-center justify-between gap-3">
                  <span className={LABEL}>run it</span>
                  <CopyButton
                    text={cmds}
                    copied={copied === "cmds"}
                    failed={failed === "cmds"}
                    onCopy={(t) => void copy(t, "cmds")}
                  />
                </div>
                <pre className="font-jetbrains mt-2 select-all overflow-x-auto rounded-lg border border-white/10 bg-white/[0.03] p-4 text-[12px] leading-relaxed text-slate-200">
                  {cmds}
                </pre>
              </div>
              <p className="font-jetbrains text-[11px] text-white/45">
                baselines are written on the first run; every run after that is a comparison.
              </p>
            </div>
          )}
        </LevelShell>
      </motion.ol>
    </div>
  );
}
