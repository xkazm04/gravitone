"use client";

// The Conversation Gym, repurposed after the prototype round: a forensic care
// room for Characters in conversation. The recording is the primary object;
// replay is a tool inside the inspector, not the entry point. Three phases
// (the Ladder's skeleton), tables for scale (the Bench's grammar), and the
// Session timeline as the drill-in layer on click.
//
// Two lenses over every session (see _gym/diagnose.ts):
//   internal — the Character's voice needs care (listen; retrain a slot)
//   external — an indication for the devs who own the brain/pipeline

import { useCallback, useState } from "react";

import AppFrame from "@/components/ui/AppFrame";
import { Eyebrow } from "@/components/ui/Primitives";

import { useForensics, useGymRuns } from "./_gym/data";
import { Phase } from "./_forensics/PhaseFrame";
import SessionsPhase from "./_forensics/SessionsPhase";
import DiagnosisPhase from "./_forensics/DiagnosisPhase";
import CarePhase from "./_forensics/CarePhase";
import SessionInspector from "./_forensics/SessionInspector";

export default function GymPage() {
  const forensics = useForensics();
  const runs = useGymRuns();
  const [inspecting, setInspecting] = useState<{ session: string; seekS?: number } | null>(null);

  const inspect = useCallback(
    (session: string, seekS?: number) => setInspecting({ session, seekS }),
    [],
  );
  const close = useCallback(() => setInspecting(null), []);

  const { sessions, recordings, loading, error, refresh } = forensics;
  const haveSessions = sessions.some((s) => s.recording.status === "complete");
  const haveFindings = sessions.some((s) => s.findings.length > 0);
  const inspected = inspecting
    ? (sessions.find((s) => s.recording.conversation_id === inspecting.session) ?? null)
    : null;

  return (
    <AppFrame>
      <main className="pb-20">
        <header className="pt-6">
          <Eyebrow>conversation gym</Eyebrow>
          <h1 className="font-instrument mt-4 text-4xl text-white">
            Every session, on the record.
          </h1>
          <p className="font-hanken mt-2 max-w-2xl text-base text-slate-400">
            Recorded conversations broken down through two lenses: what the Character&rsquo;s
            voice needs from you, and what the brain&rsquo;s developers need to hear about.
          </p>
        </header>

        <ol className="mt-10">
          <Phase
            index={0}
            title="Sessions"
            sub="what was said, and what it cost"
            state={haveSessions ? "done" : "active"}
          >
            <SessionsPhase
              sessions={sessions}
              recordingOn={recordings?.recording ?? true}
              recordingsDir={recordings?.directory ?? ""}
              loading={loading}
              error={error}
              refresh={refresh}
              onInspect={inspect}
            />
          </Phase>

          <Phase
            index={1}
            title="Diagnosis"
            sub="two lenses over every session"
            state={haveFindings ? "done" : haveSessions ? "active" : "idle"}
          >
            <DiagnosisPhase sessions={sessions} onInspect={inspect} />
          </Phase>

          <Phase
            index={2}
            title="Care & handoff"
            sub="internal to the studio · external to their devs"
            state={haveFindings ? "active" : "idle"}
            last
          >
            <CarePhase sessions={sessions} />
          </Phase>
        </ol>

        {inspected && (
          <SessionInspector
            session={inspected}
            initialSeekS={inspecting?.seekS}
            runs={runs.byRecording.get(inspected.recording.conversation_id) ?? []}
            replayState={runs.state}
            replay={runs.replay}
            dismissReplayError={runs.dismissError}
            onClose={close}
          />
        )}
      </main>
    </AppFrame>
  );
}
