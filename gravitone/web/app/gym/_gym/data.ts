"use client";

// The gym's one data layer. All three prototype variants consume THESE hooks so
// the risky parts — the in-flight gate, unmount guards, honest error surfaces,
// the 409 busy refusal — are written once. A variant is a view over this state,
// never its own fetch dialect.

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, apiJson } from "@/lib/apiFetch";
import { useMounted } from "@/lib/useMounted";

import { loadRoster, type Character } from "@/app/voices/_data/characters";

import { diagnose, type Finding } from "./diagnose";
import type {
  AgentsAnswer,
  CareAnswer,
  CareMark,
  GymComparison,
  GymRun,
  RecordingsAnswer,
  RecordingSummary,
  ReplayOptions,
  TranscriptAnswer,
} from "./types";

/** Agents + recordings, loaded together. `error` is the read failure, shown —
 *  never a false empty state. */
export function useGymSetup() {
  const mounted = useMounted();
  const [agents, setAgents] = useState<AgentsAnswer | null>(null);
  const [recordings, setRecordings] = useState<RecordingsAnswer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, r] = await Promise.all([
        apiJson<AgentsAnswer>("/api/gym/agents", undefined, "could not load the agent roster"),
        apiJson<RecordingsAnswer>(
          "/api/gym/recordings",
          undefined,
          "could not load recorded conversations",
        ),
      ]);
      if (!mounted.current) return;
      setAgents(a);
      setRecordings(r);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : "could not reach the gym");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [mounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { agents, recordings, loading, error, refresh };
}

/** One session row of the forensic room: the recording, who spoke, what the
 *  transcript shows, and what the rules found in it. */
export type SessionRow = {
  recording: RecordingSummary;
  /** The Character whose voice the agent spoke with, when the roster knows
   *  it. Absent for a voice no Character owns (e.g. a bare built-in). */
  character: { character_id: string; name: string } | null;
  voiceId: string | null;
  /** null while status is in_progress, or when the transcript read failed —
   *  transcriptError says which. */
  transcript: TranscriptAnswer | null;
  transcriptError: string | null;
  findings: Finding[];
};

/** Everything phase 1–3 render: sessions joined to Characters, transcripts
 *  loaded, findings derived. One fetch cycle, honest partial failure — a
 *  session whose transcript could not be read still appears, and says so. */
export function useForensics() {
  const mounted = useMounted();
  const [agents, setAgents] = useState<AgentsAnswer | null>(null);
  const [recordings, setRecordings] = useState<RecordingsAnswer | null>(null);
  const [roster, setRoster] = useState<Character[]>([]);
  const [transcripts, setTranscripts] = useState<
    Map<string, { transcript: TranscriptAnswer | null; error: string | null }>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, r, cs] = await Promise.all([
        apiJson<AgentsAnswer>("/api/gym/agents", undefined, "could not load the agent roster"),
        apiJson<RecordingsAnswer>(
          "/api/gym/recordings",
          undefined,
          "could not load recorded sessions",
        ),
        // A roster that fails must not take the whole room down — sessions
        // are still listable and listenable without Character names.
        loadRoster().catch(() => [] as Character[]),
      ]);
      if (!mounted.current) return;
      setAgents(a);
      setRecordings(r);
      setRoster(cs);

      const complete = r.conversations.filter((c) => c.status === "complete");
      type TranscriptEntry = readonly [
        string,
        { transcript: TranscriptAnswer | null; error: string | null },
      ];
      const loaded = await Promise.all(
        complete.map(async (c): Promise<TranscriptEntry> => {
          try {
            const t = await apiJson<TranscriptAnswer>(
              `/api/gym/recordings/${encodeURIComponent(c.conversation_id)}`,
              undefined,
              "transcript unreadable",
            );
            return [c.conversation_id, { transcript: t, error: null }] as const;
          } catch (e) {
            return [
              c.conversation_id,
              {
                transcript: null,
                error: e instanceof Error ? e.message : "transcript unreadable",
              },
            ] as const;
          }
        }),
      );
      if (!mounted.current) return;
      setTranscripts(new Map(loaded));
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : "could not reach the forensic room");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [mounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sessions: SessionRow[] = useMemo(() => {
    if (!recordings) return [];
    const voiceOf = new Map<string, string>();
    for (const agent of agents?.agents ?? []) {
      if (agent.voice_id) voiceOf.set(agent.agent_id, agent.voice_id);
    }
    const characterOf = new Map<string, { character_id: string; name: string }>();
    for (const c of roster) {
      for (const v of c.voices) {
        characterOf.set(v.voice_id, { character_id: c.character_id, name: c.name });
      }
    }
    return recordings.conversations.map((rec) => {
      const voiceId = rec.agent_id ? (voiceOf.get(rec.agent_id) ?? null) : null;
      const entry = transcripts.get(rec.conversation_id);
      const transcript = entry?.transcript ?? null;
      return {
        recording: rec,
        voiceId,
        character: voiceId ? (characterOf.get(voiceId) ?? null) : null,
        transcript,
        transcriptError: entry?.error ?? null,
        findings: transcript ? diagnose(rec.conversation_id, transcript.turns) : [],
      };
    });
  }, [recordings, agents, roster, transcripts]);

  return { sessions, agents, recordings, roster, loading, error, refresh };
}

export type ReplayState =
  | { phase: "idle" }
  | { phase: "running"; recording: string; startedAt: number }
  | { phase: "error"; message: string; busy: boolean };

/** One run of the session, in arrival order (newest first is the caller's
 *  choice). Held in memory only — a reload honestly starts an empty gym. */
export type SessionRun = {
  run: GymRun;
  at: number;
  /** Scored against the previous run of the same recording, when one existed. */
  comparison: GymComparison | null;
};

/** The replay driver: serialized (the backend runs one replay per replica and
 *  409s the second caller — the gate here keeps an honest UI from ever being
 *  that second caller), unmount-safe, with every failure kept as a sentence. */
export function useGymRuns() {
  const mounted = useMounted();
  const [runs, setRuns] = useState<SessionRun[]>([]);
  const [state, setState] = useState<ReplayState>({ phase: "idle" });

  const replay = useCallback(
    async (recording: string, opts: ReplayOptions): Promise<SessionRun | null> => {
      // In-flight gate: a double-click must not become the 409 the backend
      // would rightly answer it with.
      let already = false;
      setState((s) => {
        if (s.phase === "running") {
          already = true;
          return s;
        }
        return { phase: "running", recording, startedAt: Date.now() };
      });
      if (already) return null;
      try {
        const answer = await apiJson<{ run: GymRun }>(
          "/api/gym/replay",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recording,
              pace: opts.pace,
              polite: opts.polite,
              ...(opts.agent_id ? { agent_id: opts.agent_id } : {}),
            }),
          },
          "the replay failed",
        );
        if (!mounted.current) return null;

        // Score against the previous run of the same recording, if the pacing
        // matches — the backend refuses to score latency across two pacings,
        // and silently comparing them here would misreport an experiment
        // change as a regression.
        const baseline = runsOf(runs, answer.run.source_name)[0]?.run ?? null;
        let comparison: GymComparison | null = null;
        if (baseline) {
          try {
            comparison = await apiJson<GymComparison>(
              "/api/gym/compare",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ a: baseline, b: answer.run }),
              },
              "the comparison failed",
            );
          } catch {
            // A failed comparison must not lose the run it was about; the run
            // lands uncompared and says so (comparison: null renders as
            // "first run" / "not scored").
            comparison = null;
          }
        }
        if (!mounted.current) return null;
        const entry: SessionRun = { run: answer.run, at: Date.now(), comparison };
        setRuns((prev) => [entry, ...prev]);
        setState({ phase: "idle" });
        return entry;
      } catch (e) {
        if (!mounted.current) return null;
        const busy = e instanceof ApiError && e.status === 409;
        setState({
          phase: "error",
          message: e instanceof Error ? e.message : "the replay failed",
          busy,
        });
        return null;
      }
    },
    [mounted, runs],
  );

  const dismissError = useCallback(() => {
    setState((s) => (s.phase === "error" ? { phase: "idle" } : s));
  }, []);

  const byRecording = useMemo(() => {
    const map = new Map<string, SessionRun[]>();
    for (const r of runs) {
      const list = map.get(r.run.source_name) ?? [];
      list.push(r);
      map.set(r.run.source_name, list);
    }
    return map;
  }, [runs]);

  return { runs, byRecording, state, replay, dismissError };
}

function runsOf(runs: SessionRun[], sourceName: string): SessionRun[] {
  return runs.filter((r) => r.run.source_name === sourceName);
}

// ---------------------------------------------------------------------------
// Care marks — the operator's per-turn verdicts, whole-document semantics.
// ---------------------------------------------------------------------------

export async function fetchCare(sessionId: string): Promise<CareAnswer> {
  return apiJson<CareAnswer>(
    `/api/gym/recordings/${encodeURIComponent(sessionId)}/care`,
    undefined,
    "could not load care marks",
  );
}

export async function saveCare(sessionId: string, marks: CareMark[]): Promise<CareAnswer> {
  return apiJson<CareAnswer>(
    `/api/gym/recordings/${encodeURIComponent(sessionId)}/care`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marks }),
    },
    "could not save care marks",
  );
}

// ---------------------------------------------------------------------------
// Formatting — one dialect for the numbers every variant renders.
// ---------------------------------------------------------------------------

/** Seconds, for humans: 0.42s / 1.6s / — for absent. Never a fabricated zero. */
export function fmtS(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)}s`;
}

/** WER as a percentage with its honesty preserved: 0 → "0%", absent → "—". */
export function fmtWer(wer: number | null | undefined): string {
  if (wer === null || wer === undefined) return "—";
  return `${(wer * 100).toFixed(1)}%`;
}

export function fmtClock(epochS: number): string {
  return new Date(epochS * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
