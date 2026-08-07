"use client";

// The forensic drill-in over ONE recorded session: two aligned tracks (the
// caller's WAV and the agent's WAV share a single timeline — the backend pads
// them), the transcript as a two-voice dialogue with its per-turn costs, and
// the findings pinned to the moments they are about. Clicking a turn or a
// finding seeks BOTH tracks to that instant; nothing ever plays without a
// click (DESIGN.md: never animate — or perform — during audio playback, and
// no ambient motion lives inside this modal at all).
//
// Replay is a tool drawer at the bottom, collapsed by default: reproduce the
// session through the live pipeline, see the run scored against its baseline.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Panel } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import { useClientReady } from "@/lib/useMounted";

import type { Finding } from "../_gym/diagnose";
import { fmtClock, fmtS } from "../_gym/data";
import type { ReplayState, SessionRow, SessionRun } from "../_gym/data";
import type { RecordedTurn, ReplayOptions } from "../_gym/types";
import { ReplayKnobs, RunTotals, Verdict, DriftNote } from "../_gym/shared";

const MONO_LABEL = "font-jetbrains text-[11px] uppercase tracking-[0.18em]";

/** at_s as a m:ss mono timestamp — the timeline's clock, not a duration. */
function fmtAt(atS: number): string {
  const s = Math.max(0, Math.floor(atS));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

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
  const userRef = useRef<HTMLAudioElement>(null);
  const agentRef = useRef<HTMLAudioElement>(null);

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

  /** Seek BOTH tracks to the same instant. Never autoplays. */
  const seekBoth = useCallback((atS: number) => {
    const t = Math.max(0, atS);
    for (const el of [userRef.current, agentRef.current]) {
      if (el) el.currentTime = t;
    }
  }, []);

  // A finding chip on the sessions table can open the inspector AT a moment:
  // seek once the tracks know their duration — without playing anything.
  useEffect(() => {
    if (initialSeekS === undefined) return;
    let done = false;
    const cleanups: (() => void)[] = [];
    const trySeek = () => {
      if (done) return;
      const els = [userRef.current, agentRef.current].filter((el): el is HTMLAudioElement => !!el);
      if (els.length && els.every((el) => el.readyState >= 1)) {
        done = true;
        seekBoth(initialSeekS);
      }
    };
    trySeek();
    for (const el of [userRef.current, agentRef.current]) {
      if (!el) continue;
      el.addEventListener("loadedmetadata", trySeek);
      cleanups.push(() => el.removeEventListener("loadedmetadata", trySeek));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [initialSeekS, seekBoth]);

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
          </div>
        </Panel>
      </motion.div>
    </div>,
    document.body,
  );
}

/** One turn of the dialogue: candidate hugs the left hairline, the agent is
 *  indented on cyan. The whole row is a button — clicking seeks both tracks
 *  to at_s, and never autoplays. */
function TurnRow({
  turn,
  index,
  findings,
  onSeek,
}: {
  turn: RecordedTurn;
  index: number;
  findings: Finding[];
  onSeek: (atS: number) => void;
}) {
  const isAgent = turn.role === "agent";
  return (
    <li>
      <button
        type="button"
        onClick={() => onSeek(turn.at_s)}
        title={`seek both tracks to ${fmtAt(turn.at_s)}`}
        className={`block w-full rounded-r-lg border-l py-2 pl-4 text-left transition hover:bg-white/[0.03] ${
          isAgent ? "ml-8 border-cyan-400/40" : "border-white/25"
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={`${MONO_LABEL} ${isAgent ? "text-cyan-300/80" : "text-white/45"}`}>
            {isAgent ? "agent" : "caller"}
          </span>
          <span className="font-jetbrains text-[11px] text-white/45">{fmtAt(turn.at_s)}</span>
          {!isAgent && typeof turn.transcribe_s === "number" && (
            <span className="font-jetbrains text-[11px] text-white/45">
              heard in {fmtS(turn.transcribe_s)}
            </span>
          )}
          {isAgent && typeof turn.answer_s === "number" && (
            <span className="font-jetbrains text-[11px] text-white/45">
              answered in {fmtS(turn.answer_s)}
            </span>
          )}
          {turn.interrupted && (
            <span className="font-jetbrains rounded-full border border-rose-400/30 bg-rose-400/5 px-2 py-0.5 text-[11px] text-rose-300">
              cut off
            </span>
          )}
          {findings.map((f) => (
            <FindingChip key={f.id} finding={f} />
          ))}
        </div>
        <p className="font-hanken mt-1 text-[15px] text-slate-200">{turn.text}</p>
      </button>
    </li>
  );
}

/** A finding as a chip: rose for a concern, amber for a notice; the summary
 *  rides in the title so the chip stays one word wide. */
function FindingChip({ finding, className = "" }: { finding: Finding; className?: string }) {
  const palette =
    finding.severity === "concern"
      ? "border-rose-400/30 bg-rose-400/5 text-rose-300"
      : "border-amber-400/30 bg-amber-400/5 text-amber-300";
  return (
    <span
      title={finding.summary}
      className={`font-jetbrains inline-flex rounded-full border px-2 py-0.5 text-[11px] ${palette} ${className}`}
    >
      {finding.kind}
    </span>
  );
}
