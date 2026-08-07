"use client";

// Phase 1 of the forensic room: the sessions table — the scale surface.
// Restrained tier (DESIGN.md): a working tool, no performing illustration.
// The one entrance is `rise` on the table container; every number rendered
// here is the recording's own, with "—" for absent (never a fabricated zero).

import { motion } from "framer-motion";

import { Button } from "@/components/ui/Primitives";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { rise } from "@/components/ui/tokens";

import type { SessionRow } from "../_gym/data";
import { fmtClock, fmtS } from "../_gym/data";
import { GymEmpty } from "../_gym/shared";

const TH =
  "font-jetbrains py-2 text-left text-[11px] font-normal uppercase tracking-[0.18em] text-white/45";
const MONO = "font-jetbrains text-[12px]";

export default function SessionsPhase({
  sessions,
  recordingOn,
  recordingsDir,
  loading,
  error,
  refresh,
  onInspect,
}: {
  sessions: SessionRow[];
  recordingOn: boolean;
  recordingsDir: string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void> | void;
  onInspect: (sessionId: string, seekS?: number) => void;
}) {
  if (loading) {
    return (
      <p className="font-jetbrains text-[12px] uppercase tracking-widest text-white/50">
        loading sessions…
      </p>
    );
  }

  if (error) {
    return (
      <div>
        <ErrorBanner severity="error" className="mt-0">
          {error}
        </ErrorBanner>
        <Button
          variant="ghost"
          className="mt-3 px-4 py-2 text-[12px]"
          onClick={() => void refresh()}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return <GymEmpty recordingOn={recordingOn} directory={recordingsDir} />;
  }

  const withFindings = sessions.filter((s) => s.findings.length > 0).length;

  return (
    <div>
      <motion.div
        className="overflow-x-auto"
        variants={rise}
        initial="hidden"
        animate="show"
      >
        <table className="min-w-[720px] w-full border-collapse">
          <thead>
            <tr className="border-b border-white/8">
              <th className={TH}>session</th>
              <th className={TH}>character</th>
              <th className={TH}>turns</th>
              <th className={TH}>duration</th>
              <th className={TH}>interruptions</th>
              <th className={TH}>findings</th>
              <th className={TH}>recorded</th>
              <th className={TH}>status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {sessions.map((s) => (
              <Row key={s.recording.conversation_id} session={s} onInspect={onInspect} />
            ))}
          </tbody>
        </table>
      </motion.div>
      <p className="font-jetbrains mt-3 text-[11px] text-white/45">
        {sessions.length} session{sessions.length === 1 ? "" : "s"} · {withFindings} with findings
      </p>
    </div>
  );
}

function Row({
  session,
  onInspect,
}: {
  session: SessionRow;
  onInspect: (sessionId: string, seekS?: number) => void;
}) {
  const { recording, character, voiceId, findings, transcriptError } = session;
  const id = recording.conversation_id;
  const running = recording.status === "in_progress";
  const interruptions = findings.filter((f) => f.kind === "barge-in").length;
  const concerns = findings.filter((f) => f.severity === "concern").length;

  const open = () => {
    if (!running) onInspect(id);
  };

  return (
    <tr
      className={
        running
          ? "opacity-60"
          : "group cursor-pointer transition-colors hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2"
      }
      tabIndex={running ? undefined : 0}
      role={running ? undefined : "button"}
      aria-label={running ? undefined : `inspect session ${id}`}
      onClick={open}
      onKeyDown={(e) => {
        if (!running && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
        }
      }}
    >
      <td className={`${MONO} py-2.5 pr-4 text-white/85`} title={id}>
        {id.length > 10 ? `${id.slice(0, 10)}…` : id}
      </td>
      <td className="font-hanken py-2.5 pr-4 text-base text-slate-300">
        {character ? (
          character.name
        ) : voiceId ? (
          <span className={`${MONO} text-white/45`}>{voiceId}</span>
        ) : (
          <span className="text-white/45">—</span>
        )}
      </td>
      <td className={`${MONO} py-2.5 pr-4 text-white/85`}>
        {recording.turns ?? "—"}
      </td>
      <td className={`${MONO} py-2.5 pr-4 text-white/85`}>{fmtS(recording.duration_s)}</td>
      <td className={`${MONO} py-2.5 pr-4 ${interruptions > 0 ? "text-rose-300" : "text-white/45"}`}>
        {interruptions}
      </td>
      <td className={`${MONO} py-2.5 pr-4`}>
        {transcriptError ? (
          <span className="text-rose-300">transcript unreadable</span>
        ) : findings.length === 0 ? (
          <span className="text-emerald-300/80">clean</span>
        ) : (
          <span
            className="text-white/85"
            title={`${concerns} concern${concerns === 1 ? "" : "s"} · ${findings.length - concerns} notice${findings.length - concerns === 1 ? "" : "s"}`}
          >
            {findings.length}
          </span>
        )}
      </td>
      <td className={`${MONO} py-2.5 pr-4 text-white/60`}>{fmtClock(recording.recorded_at)}</td>
      <td className="font-jetbrains py-2.5 text-[11px]">
        {running ? (
          <span className="text-amber-300/90">call still running</span>
        ) : (
          <span className="text-cyan-300 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            inspect →
          </span>
        )}
      </td>
    </tr>
  );
}
