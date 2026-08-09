"use client";

// Replay is a tool drawer at the bottom, collapsed by default: reproduce the
// session through the live pipeline, see the run scored against its baseline.

import { useEffect, useState } from "react";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button } from "@/components/ui/Primitives";

import { fmtClock } from "../_gym/data";
import type { ReplayState, SessionRun } from "../_gym/data";
import type { ReplayOptions } from "../_gym/types";
import { ReplayKnobs, RunTotals, Verdict, DriftNote } from "../_gym/gymParts";
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
            </div>
          ))}
          {runs.length > 0 && <DriftNote />}
        </div>
      )}
    </div>
  );
}
