"use client";

// The forensic drill-in over ONE recorded session: two aligned tracks (the
// caller's WAV and the agent's WAV share a single timeline — the backend pads
// them), the transcript as a two-voice dialogue with its per-turn costs, and
// the findings pinned to the moments they are about. Clicking a turn or a
// finding seeks BOTH tracks to that instant; nothing ever plays without a
// click (DESIGN.md: never animate — or perform — during audio playback, and
// no ambient motion lives inside this modal at all).

import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Panel } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import { useClientReady } from "@/lib/useMounted";

import type { Finding } from "../_gym/diagnose";
import { fmtClock, fmtS } from "../_gym/data";
import type { ReplayState, SessionRow, SessionRun } from "../_gym/data";
import type { ReplayOptions } from "../_gym/types";
import GymReplayDrawer from "./GymReplayDrawer";
import { FindingChip, MONO_LABEL, TurnRow } from "./GymSessionTurns";
import { useGymTrackSeek } from "./useGymTrackSeek";

export default function SessionInspector({
  session,
  initialSeekS,
  runs,
  replayState,
  replay,
  dismissReplayError,
  onClose,
}: {
  session: SessionRow;
  initialSeekS?: number;
  runs: SessionRun[];
  replayState: ReplayState;
  replay: (recording: string, opts: ReplayOptions) => Promise<SessionRun | null>;
  dismissReplayError: () => void;
  onClose: () => void;
}) {
  const ready = useClientReady();
  const { userRef, agentRef, seekBoth } = useGymTrackSeek(initialSeekS);

  const rec = session.recording;
  const id = rec.conversation_id;
  const audioBase = `/api/gym/recordings/${encodeURIComponent(id)}/audio`;

  // One gesture each way: Escape closes, like the scrim and the button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The page behind must not scroll while the modal owns the viewport.
  useEffect(() => {
    document.body.classList.add("overflow-hidden");
    return () => document.body.classList.remove("overflow-hidden");
  }, []);

  // Findings pinned to their turns, so a chip renders beside the words it is
  // about; the session-level ones (no turn index) render under the header.
  const findingsByTurn = useMemo(() => {
    const map = new Map<number, Finding[]>();
    for (const f of session.findings) {
      if (f.turn === undefined) continue;
      const list = map.get(f.turn) ?? [];
      list.push(f);
      map.set(f.turn, list);
    }
    return map;
  }, [session.findings]);
  const sessionFindings = session.findings.filter((f) => f.turn === undefined);

  if (!ready) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto p-4 sm:p-8" role="dialog" aria-modal="true">
      {/* scrim — click to close */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      {/* Entrance only: one fade/rise on mount, then the modal holds still —
          audio may be playing at any moment after this. */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
        className="relative"
      >
        <Panel className="mx-auto flex max-h-[85vh] max-w-4xl flex-col">
          {/* ---- header ---- */}
          <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/8 p-5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-jetbrains truncate text-sm text-white">{id}</span>
                {session.character && (
                  <span className="font-instrument text-xl text-white">
                    {session.character.name}
                  </span>
                )}
              </div>
              <div className="font-jetbrains mt-1 flex flex-wrap gap-x-4 text-[12px] text-white/45">
                {rec.agent_id && <span>{rec.agent_id}</span>}
                <span>{fmtClock(rec.recorded_at)}</span>
                <span>{rec.duration_s !== undefined ? fmtS(rec.duration_s) : "—"}</span>
              </div>
            </div>
            <Button variant="ghost" aria-label="Close" onClick={onClose} className="px-4 py-2">
              ✕
            </Button>
          </header>

          {/* ---- scrollable body ---- */}
          <div className="scroll-y min-h-0 flex-1 overflow-y-auto p-5">
            {sessionFindings.map((f) => (
              <FindingChip key={f.id} finding={f} className="mr-2 mb-3" />
            ))}

            {/* the two tracks — one timeline, two voices */}
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["caller", "user", userRef],
                  ["agent", "agent", agentRef],
                ] as const
              ).map(([label, path, ref]) => (
                <div key={path}>
                  <div className={`${MONO_LABEL} mb-1 text-white/45`}>{label}</div>
                  <audio
                    ref={ref}
                    controls
                    preload="metadata"
                    src={`${audioBase}/${path}`}
                    className="w-full"
                  />
                </div>
              ))}
            </div>

            {/* the timeline */}
            <div className="mt-6">
              {session.transcript ? (
                <ol className="space-y-3">
                  {session.transcript.turns.map((t, i) => (
                    <TurnRow
                      key={i}
                      turn={t}
                      index={i}
                      findings={findingsByTurn.get(i) ?? []}
                      onSeek={seekBoth}
                    />
                  ))}
                </ol>
              ) : session.transcriptError ? (
                <ErrorBanner className="mt-0">{session.transcriptError}</ErrorBanner>
              ) : (
                <ErrorBanner severity="warning" className="mt-0">
                  call still running — no transcript yet
                </ErrorBanner>
              )}
            </div>

            {/* ---- reproduce (tool drawer, collapsed by default) ---- */}
            <GymReplayDrawer
              id={id}
              runs={runs}
              replayState={replayState}
              replay={replay}
              dismissReplayError={dismissReplayError}
            />
          </div>
        </Panel>
      </motion.div>
    </div>,
    document.body,
  );
}
