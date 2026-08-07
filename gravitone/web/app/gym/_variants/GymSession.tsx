"use client";

// SESSION — the conversation relived. The object on screen is the CALL ITSELF:
// a two-voice transcript timeline, with every measured cost annotated in place
// on the turn that earned it. Where Bench reads like an instrument and Ladder
// like a progression, Session reads like a fight card — pick a recorded spar,
// replay it, and read the exchange blow by blow. The one Signal accent is the
// entrance: a fresh run re-plays the timeline's staggered rise, keyed by run_id.

import { useMemo, useState } from "react";
import { motion } from "framer-motion";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Panel } from "@/components/ui/Primitives";
import { rise } from "@/components/ui/tokens";
import { useStillMotion } from "@/lib/useStillMotion";

import { fmtClock, fmtS, useGymRuns, useGymSetup, type SessionRun } from "../_gym/data";
import {
  ChecksTable,
  DriftNote,
  GymEmpty,
  ReplayKnobs,
  RunTotals,
  Verdict,
} from "../_gym/shared";
import type { GymTurn, RecordingSummary } from "../_gym/types";

const LABEL = "font-jetbrains text-[11px] uppercase tracking-[0.18em] text-white/45";

/** A mono annotation chip. Absent measurements never reach this component —
 *  the caller renders NOTHING for a null, per the artifact's own rule. */
function Chip({ tone, children }: { tone: "quiet" | "cyan" | "rose"; children: React.ReactNode }) {
  const palette =
    tone === "rose"
      ? "border-rose-400/30 bg-rose-400/5 text-rose-300"
      : tone === "cyan"
        ? "border-cyan-400/25 bg-cyan-400/5 text-cyan-200"
        : "border-white/10 bg-white/[0.03] text-white/60";
  return (
    <span className={`font-jetbrains inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${palette}`}>
      {children}
    </span>
  );
}

/** One dialogue row — the turn's text with its costs annotated where they
 *  happened. Candidate speaks from the left margin; the agent is indented
 *  under a cyan-tinted hairline, so the two voices read at a glance. */
function TurnRow({
  turn,
  was,
  still,
  index,
}: {
  turn: GymTurn;
  /** The baseline's text for this turn, when the comparison says it changed. */
  was: string | null | undefined;
  still: boolean;
  index: number;
}) {
  const agent = turn.role === "agent";
  const chips: React.ReactNode[] = [];
  if (agent && turn.answer_s !== null) {
    chips.push(<Chip key="answer" tone="cyan">answered in {fmtS(turn.answer_s)}</Chip>);
  }
  if (!agent && turn.transcribe_s !== null) {
    chips.push(<Chip key="heard" tone="quiet">heard in {fmtS(turn.transcribe_s)}</Chip>);
  }
  if (turn.interrupted) {
    chips.push(<Chip key="cut" tone="rose">cut off — barge-in</Chip>);
  }
  return (
    <motion.li
      variants={rise}
      custom={index}
      initial={still ? false : "hidden"}
      animate="show"
      className={`border-l py-2 pl-4 ${
        agent ? "ml-8 border-cyan-400/30 sm:ml-14" : "mr-8 border-white/15 sm:mr-14"
      }`}
    >
      <div className={LABEL}>{agent ? "agent" : "candidate"} · turn {turn.i}</div>
      <p className="font-hanken mt-1 text-base text-white/85">{turn.text}</p>
      {was !== undefined && (
        <div className="mt-2 rounded-lg border border-rose-400/25 bg-rose-400/5 px-3 py-2">
          <span className="font-jetbrains text-[11px] text-rose-300">was: </span>
          <span className="font-hanken text-[13px] text-rose-200/90">{was ?? "(no reply)"}</span>
        </div>
      )}
      {chips.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{chips}</div>}
    </motion.li>
  );
}

/** One recording as a pickable card in the rail. */
function RecordingCard({
  rec,
  selected,
  onPick,
}: {
  rec: RecordingSummary;
  selected: boolean;
  onPick: () => void;
}) {
  const busy = rec.status === "in_progress";
  const facts: string[] = [];
  if (rec.turns !== undefined) facts.push(`${rec.turns} turns`);
  if (rec.duration_s !== undefined) facts.push(fmtS(rec.duration_s));
  return (
    <Panel
      className={`transition ${selected ? "border-cyan-400/40" : busy ? "" : "hover:border-white/20"}`}
    >
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        className="w-full p-4 text-left disabled:opacity-60"
      >
        <div className={`font-jetbrains truncate text-[12px] ${selected ? "text-cyan-200" : "text-white/85"}`}>
          {rec.conversation_id}
        </div>
        {rec.agent_id && (
          <div className="font-jetbrains mt-1 truncate text-[11px] text-white/45">{rec.agent_id}</div>
        )}
        <div className="font-jetbrains mt-2 flex items-baseline justify-between gap-2 text-[11px] text-white/60">
          <span>{facts.join(" · ")}</span>
          <span className="text-white/40">{fmtClock(rec.recorded_at)}</span>
        </div>
        {busy && (
          <div className="font-jetbrains mt-2 text-[11px] text-amber-200/90">
            still in progress — not replayable yet
          </div>
        )}
      </button>
    </Panel>
  );
}

export default function GymSession() {
  const still = useStillMotion();
  const setup = useGymSetup();
  const { byRecording, state, replay, dismissError } = useGymRuns();

  const [selected, setSelected] = useState<string | null>(null);
  const [viewedRunId, setViewedRunId] = useState<string | null>(null);
  const [pace, setPace] = useState(1);
  const [polite, setPolite] = useState(true);
  const [checksOpen, setChecksOpen] = useState(false);

  const conversations = setup.recordings?.conversations ?? [];
  const selectedRec = conversations.find((c) => c.conversation_id === selected) ?? null;

  // Runs of the selected recording, newest first. byRecording keys on the
  // run's source_name; fall back on the artifact's own source fields so a
  // backend that names the source differently still lands in the view.
  const runsForSelection: SessionRun[] = useMemo(() => {
    if (!selected) return [];
    const direct = byRecording.get(selected);
    if (direct && direct.length > 0) return direct;
    for (const list of byRecording.values()) {
      const hit = list.filter(
        (r) => r.run.conversation_id === selected || r.run.source_recording === selected,
      );
      if (hit.length > 0) return hit;
    }
    return [];
  }, [byRecording, selected]);

  const viewed =
    runsForSelection.find((r) => r.run.run_id === viewedRunId) ?? runsForSelection[0] ?? null;

  const changedByTurn = useMemo(() => {
    const map = new Map<number, string | null>();
    for (const c of viewed?.comparison?.agent_text.changed ?? []) map.set(c.i, c.a);
    return map;
  }, [viewed]);

  const running = state.phase === "running";

  const pick = (id: string) => {
    setSelected(id);
    setViewedRunId(null);
    setChecksOpen(false);
  };

  const doReplay = async () => {
    if (!selected || running) return;
    const entry = await replay(selected, { pace, polite });
    if (entry) setViewedRunId(entry.run.run_id);
  };

  // ---- edge states before the session can exist -------------------------
  if (setup.loading) {
    return <p className="font-jetbrains py-10 text-[12px] text-white/45">loading…</p>;
  }
  if (setup.error) {
    return (
      <div>
        <ErrorBanner className="mt-0">{setup.error}</ErrorBanner>
        <Button variant="ghost" className="mt-4" onClick={() => void setup.refresh()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!setup.recordings || conversations.length === 0) {
    return (
      <Panel className="p-5">
        <GymEmpty
          recordingOn={setup.recordings?.recording ?? false}
          directory={setup.recordings?.directory ?? ""}
        />
      </Panel>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      {/* -------- picker rail: the recorded spars ------------------------ */}
      <div>
        <div className={LABEL}>recorded calls</div>
        <div className="mt-3 flex flex-col gap-3">
          {conversations.map((rec) => (
            <RecordingCard
              key={rec.conversation_id}
              rec={rec}
              selected={rec.conversation_id === selected}
              onPick={() => pick(rec.conversation_id)}
            />
          ))}
        </div>

        <div className="mt-5">
          <ReplayKnobs
            pace={pace}
            polite={polite}
            onPace={setPace}
            onPolite={setPolite}
            disabled={running}
          />
          <Button
            className="mt-4 w-full"
            disabled={!selectedRec || selectedRec.status === "in_progress" || running}
            onClick={() => void doReplay()}
          >
            {running ? "Replaying…" : "Replay this call"}
          </Button>
          {running && (
            <p className="font-jetbrains mt-2 text-[11px] text-white/45">
              replaying — a real-time replay takes as long as the call did
            </p>
          )}
          {state.phase === "error" && (
            <div>
              <ErrorBanner>{state.message}</ErrorBanner>
              <Button variant="ghost" className="mt-2" onClick={dismissError}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* -------- the session view: the call relived --------------------- */}
      <div className="min-w-0">
        {!selected ? (
          <Panel className="p-5">
            <p className="font-hanken py-8 text-center text-base text-slate-300">
              Pick a recorded call on the left to relive it here.
            </p>
          </Panel>
        ) : !viewed ? (
          <Panel className="p-5">
            <p className="font-hanken py-8 text-center text-base text-slate-300">
              No run yet for this recording. Replay it to relive the call with its costs annotated.
            </p>
          </Panel>
        ) : (
          // Keyed by run_id: a NEW run remounts the session and replays the
          // staggered entrance — the one Signal accent of this surface.
          <div key={viewed.run.run_id}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-jetbrains text-[12px] text-white/85">
                {viewed.run.source_name}
              </span>
              <Chip tone="quiet">{viewed.run.run_id}</Chip>
              {typeof viewed.run.brain.backend === "string" && (
                <Chip tone="quiet">brain {viewed.run.brain.backend}</Chip>
              )}
              <Chip tone="quiet">{viewed.run.wire.pace >= 1 ? "real-time" : "fast"}</Chip>
              <Chip tone="quiet">{viewed.run.wire.polite ? "polite" : "barge-in"}</Chip>
              {viewed.comparison && <Verdict verdict={viewed.comparison.verdict} />}
            </div>

            <ol className="mt-5 flex flex-col">
              {viewed.run.turns.map((turn, i) => (
                <TurnRow
                  key={turn.i}
                  turn={turn}
                  was={
                    turn.role === "agent" && changedByTurn.has(turn.i)
                      ? changedByTurn.get(turn.i)
                      : undefined
                  }
                  still={still}
                  index={i}
                />
              ))}
            </ol>

            <Panel className="mt-6 p-5">
              <RunTotals run={viewed.run} />
              <DriftNote className="mt-3" />
            </Panel>

            {viewed.comparison && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setChecksOpen((v) => !v)}
                  className={`${LABEL} transition hover:text-white/70`}
                  aria-expanded={checksOpen}
                >
                  {checksOpen ? "hide" : "all"} checks ({viewed.comparison.checks.length})
                </button>
                {checksOpen && (
                  <Panel className="mt-2 p-5">
                    <ChecksTable checks={viewed.comparison.checks} />
                  </Panel>
                )}
              </div>
            )}
          </div>
        )}

        {/* -------- prior rounds of this spar ---------------------------- */}
        {runsForSelection.length > 1 && (
          <div className="mt-6 border-t border-white/8 pt-3">
            <div className={LABEL}>rounds</div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              {runsForSelection.map((r) => {
                const active = viewed?.run.run_id === r.run.run_id;
                return (
                  <button
                    key={r.run.run_id}
                    type="button"
                    onClick={() => setViewedRunId(r.run.run_id)}
                    className={`font-jetbrains inline-flex items-center gap-2 text-[11px] transition ${
                      active ? "text-cyan-200" : "text-white/50 hover:text-white/80"
                    }`}
                  >
                    {r.run.run_id}
                    {r.comparison ? (
                      <Verdict verdict={r.comparison.verdict} />
                    ) : (
                      <span className="text-white/35">first run</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
