"use client";

// The gym's one data layer. All three prototype variants consume THESE hooks so
// the risky parts — the in-flight gate, unmount guards, honest error surfaces,
// the 409 busy refusal — are written once. A variant is a view over this state,
// never its own fetch dialect.

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, apiJson } from "@/lib/apiFetch";
import { useMounted } from "@/lib/useMounted";

import type {
  AgentsAnswer,
  GymComparison,
  GymRun,
  RecordingsAnswer,
  ReplayOptions,
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
