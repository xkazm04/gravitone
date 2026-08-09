"use client";

// Replay is a tool drawer at the bottom, collapsed by default: reproduce the
// session through the live pipeline, see the run scored against its baseline.

import { useEffect, useState } from "react";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button } from "@/components/ui/Primitives";

import { fmtClock } from "../_gym/data";
import type { ReplayState, SessionRun } from "../_gym/data";
import type { GymComparison, ReplayOptions } from "../_gym/types";
import { ChecksTable, ReplayKnobs, RunTotals, Verdict, DriftNote } from "../_gym/gymParts";
import { MONO_LABEL } from "./GymSessionTurns";

export default function GymReplayDrawer({
  id,
  runs,
  replayState,
  replay,
  dismissReplayError,
}: {
  id: string;
  runs: SessionRun[];
  replayState: ReplayState;
  replay: (recording: string, opts: ReplayOptions) => Promise<SessionRun | null>;
  dismissReplayError: () => void;
}) {
  // ---- reproduce drawer -----------------------------------------------------
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pace, setPace] = useState(0);
  const [polite, setPolite] = useState(true);
  const running = replayState.phase === "running";
  const [elapsedS, setElapsedS] = useState(0);
  useEffect(() => {
    if (replayState.phase !== "running") return;
    const startedAt = replayState.startedAt;
    setElapsedS(0);
    const t = window.setInterval(() => setElapsedS((Date.now() - startedAt) / 1000), 500);
    return () => window.clearInterval(t);
  }, [replayState]);

  return (
    <div className="mt-8 border-t border-white/8 pt-5">
      <Button
        variant="ghost"
        className="px-4 py-2 text-[12px]"
        onClick={() => setDrawerOpen((v) => !v)}
        aria-expanded={drawerOpen}
      >
        {drawerOpen ? "Hide reproduction" : "Reproduce this session"}
      </Button>

      {drawerOpen && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <ReplayKnobs
              pace={pace}
              polite={polite}
              onPace={setPace}
              onPolite={setPolite}
              disabled={running}
            />
            <Button
              className="px-5 py-2 text-[13px]"
              disabled={running}
              onClick={() => void replay(id, { pace, polite })}
            >
              Replay now
            </Button>
            {running && (
              <span className="font-jetbrains text-[12px] text-white/45">
                replaying… {elapsedS.toFixed(0)}s
              </span>
            )}
          </div>

          {replayState.phase === "error" && (
            <ErrorBanner className="mt-0">
              {replayState.message}{" "}
              <button
                type="button"
                onClick={dismissReplayError}
                className="font-jetbrains underline underline-offset-2"
              >
                dismiss
              </button>
            </ErrorBanner>
          )}

          {runs.map((r, i) => (
            <div key={r.run.run_id} className="rounded-xl border border-white/8 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-jetbrains text-[12px] text-white/85">
                  {r.run.run_id}
                </span>
                <span className="font-jetbrains text-[11px] text-white/45">
                  {fmtClock(Math.floor(r.at / 1000))}
                </span>
                {r.comparison ? (
                  <Verdict verdict={r.comparison.verdict} />
                ) : i === runs.length - 1 ? (
                  <span
                    className={`${MONO_LABEL} rounded-full border border-white/15 px-3 py-1 text-white/60`}
                  >
                    baseline
                  </span>
                ) : null}
              </div>
              <div className="mt-3">
                <RunTotals run={r.run} />
              </div>
              {r.comparison && (
                <div className="mt-4 space-y-5 border-t border-white/8 pt-4">
                  <div>
                    <h4 className={`${MONO_LABEL} text-white/45`}>checks</h4>
                    <div className="mt-1">
                      <ChecksTable checks={r.comparison.checks} />
                    </div>
                  </div>
                  <AgentTextDiff agentText={r.comparison.agent_text} />
                </div>
              )}
            </div>
          ))}
          {runs.length > 0 && <DriftNote />}
        </div>
      )}
    </div>
  );
}

/** WHICH agent turns changed, and to what. A verdict of "fail" on
 *  agent_text_stable tells you the replay diverged; without the lines, the only
 *  way to see HOW is to diff two transcripts by eye — in a forensics tool.
 *  `i` indexes the AGENT turns of the run (gym.py::_texts), not the transcript,
 *  and a null side means that run had no such turn at all. */
function AgentTextDiff({ agentText }: { agentText: GymComparison["agent_text"] }) {
  const { changed, unchanged } = agentText;
  return (
    <div>
      <h4 className={`${MONO_LABEL} text-white/45`}>agent text</h4>
      <p className="font-jetbrains mt-1 text-[11px] text-white/45">
        {changed.length} changed · {unchanged} held
      </p>
      {changed.length === 0 ? (
        <p className="font-hanken mt-2 text-[13px] text-slate-400">
          Every agent turn came back word for word.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {changed.map((c) => (
            <li key={c.i} className="border-l border-white/10 pl-3">
              <div className={`${MONO_LABEL} text-white/45`}>agent turn {c.i}</div>
              <p className="font-hanken mt-1 text-[13px] text-slate-500">
                <span className={`${MONO_LABEL} mr-2 text-white/35`}>was</span>
                {c.a ?? <em className="text-slate-500">no such turn in the baseline run</em>}
              </p>
              <p className="font-hanken mt-1 text-[13px] text-slate-200">
                <span className={`${MONO_LABEL} mr-2 text-cyan-300/70`}>now</span>
                {c.b ?? <em className="text-slate-500">no such turn in this run</em>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
