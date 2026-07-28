"use client";

import { useEffect, useRef, useState } from "react";

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
  // The cadence a consumer wants right now. It lives in a ref because a
  // consumer that speeds the poller up while it works (the playground: 5s while
  // rendering, 30s idle) used to tear the whole effect down and re-arm it,
  // firing one EXTRA /api/health on every single change. The loop below is
  // self-scheduling and simply re-reads this.
  const delay = useRef(intervalMs);
  const reschedule = useRef<() => void>(() => {});

  useEffect(() => {
    delay.current = intervalMs;
    reschedule.current();   // apply the new cadence to the pending wait
  }, [intervalMs]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastAt = 0;
    const arm = () => {
      clearTimeout(timer);
      // Measured from the last request, so speeding the poller up shortens the
      // CURRENT wait instead of waiting out the old interval first (and slowing
      // it down never fires early).
      timer = setTimeout(tick, Math.max(0, delay.current - (Date.now() - lastAt)));
    };
    const tick = async () => {
      lastAt = Date.now();
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        const body = (await r.json()) as Health;
        if (!alive) return;
        setHealth(body);
        setStale(false);
      } catch {
        // Keep the last snapshot on screen but mark it stale — blanking it
        // would read as "zero traffic" rather than "we can't see the backend".
        if (!alive) return;
        setStale(true);
      }
      if (alive) arm();
    };
    reschedule.current = () => { if (alive && lastAt > 0) arm(); };
    void tick();
    return () => { alive = false; clearTimeout(timer); reschedule.current = () => {}; };
  }, []);

  return { health, stale };
}
