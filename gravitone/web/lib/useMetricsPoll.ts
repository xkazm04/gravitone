"use client";

import { useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/apiFetch";

/** The shape service/app.py::metrics actually returns. Every field is optional
 *  on purpose: this is a snapshot of a live engine, and several of its numbers
 *  are genuinely ABSENT rather than zero — `realtime_factor` is null until the
 *  engine has both a synth window and an audio window, and the percentiles are
 *  null on an engine that has served nothing. A renderer must be able to tell
 *  "not measured yet" from "measured, and it is 0". */
export type EngineMetrics = {
  received?: number;
  completed?: number;
  rejected_429?: number;
  errored?: number;
  timeouts?: number;
  abandoned?: number;
  cache_hits?: number;
  collapsed?: number;
  in_flight?: number;
  queued?: number;
  audio_seconds_total?: number;
  latency_p50_s?: number | null;
  latency_p95_s?: number | null;
  latency_p99_s?: number | null;
  synth_p50_s?: number | null;
  realtime_factor?: number | null;
  window_size?: number;
  cost_model?: { realtime_factor?: number | null; spread?: number | null; basis?: string };
};

export type MetricsPayload = {
  config?: Record<string, unknown>;
  metrics?: EngineMetrics;
  cache?: Record<string, number>;
};

export type MetricsPollState = {
  /** Last snapshot we successfully read. Null until the first one lands. */
  data: MetricsPayload | null;
  /** Why the last read failed, if it did. Null while the poller is healthy. */
  error: string | null;
  /** Consecutive failed reads. 0 while healthy. */
  failures: number;
  /** True once `data` is older than the last attempt — the numbers on screen
   *  are real, but they are not current. */
  stale: boolean;
  /** True before the first attempt has resolved either way. */
  loading: boolean;
};

/**
 * Poll `/api/metrics`.
 *
 * A sibling of `lib/useHealthPoll`, not a fork of it: same self-scheduling
 * alive-flagged loop, but a different endpoint, a different payload and one
 * behavioural difference that matters. useHealthPoll retries forever and only
 * reports `stale`. This one also carries the FAILURE — the repo's rule is that
 * a poller which retries forever has to tell the user the connection is
 * degraded (see useIngestJob's onStalled), and an ops page is the surface where
 * silently freezing on a stale snapshot would be worst: the whole reason
 * someone opens it is to find out whether the backend is healthy.
 *
 * The two honesty properties this encodes:
 *   * A failed read NEVER clears `data`. Blanking the tiles would render as
 *     "zero traffic" when it means "we cannot see the backend" — and zero
 *     in-flight is a real, reassuring state that must not be faked.
 *   * A failed read never substitutes zeros for absent fields. `stale` plus the
 *     last real snapshot is the honest picture; a fabricated zero is not.
 */
export function useMetricsPoll(intervalMs = 5_000): MetricsPollState {
  const [state, setState] = useState<MetricsPollState>({
    data: null, error: null, failures: 0, stale: false, loading: true,
  });
  const delay = useRef(intervalMs);

  useEffect(() => { delay.current = intervalMs; }, [intervalMs]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const body = await apiJson<MetricsPayload>(
          "/api/metrics", { cache: "no-store" }, "Could not read engine metrics");
        if (!alive) return;
        setState({ data: body, error: null, failures: 0, stale: false, loading: false });
      } catch (e) {
        if (!alive) return;
        // Keep the last snapshot; mark it stale and count the failure so the
        // page can escalate from "one blip" to "the backend is gone".
        setState((prev) => ({
          data: prev.data,
          error: e instanceof Error ? e.message : "Could not read engine metrics",
          failures: prev.failures + 1,
          stale: prev.data !== null,
          loading: false,
        }));
      }
      if (alive) timer = setTimeout(tick, delay.current);
    };

    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  return state;
}
