"use client";

import { useEffect, useState } from "react";

export type Health = {
  status: string;
  config?: Record<string, unknown>;
  metrics?: Record<string, number>;
};

/**
 * One poller for `/api/health`.
 *
 * BenchmarksView and SavingsTicker each hand-rolled a 30s interval against the
 * same endpoint — exactly the drift the ingest state machine's header warns
 * about ("no more two hand-rolled pollers that drift"). Alive-flagged, interval
 * cleared on unmount, and it reports `stale` so a consumer can say the numbers
 * are old instead of rendering a dead snapshot as if it were live.
 *
 * A draining backend answers 503 {"status":"draining"} — that is a real state,
 * not a transport failure, so it is passed through rather than treated as down.
 */
export function useHealthPoll(intervalMs = 30_000) {
  const [health, setHealth] = useState<Health | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        const body = (await r.json()) as Health;
        if (!alive) return;
        setHealth(body);
        setStale(false);
      } catch {
        // Keep the last snapshot on screen but mark it stale — blanking it
        // would read as "zero traffic" rather than "we can't see the backend".
        if (alive) setStale(true);
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs]);

  return { health, stale };
}
