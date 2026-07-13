import { useEffect, useRef } from "react";
import { TERMINAL_STATUSES, type Job } from "./machine";

/**
 * Polls GET /api/ingest/{job} while `enabled`, funnelling every payload back
 * through `onJob` (which the page turns into a JOB_POLLED action). This is the
 * single poller for BOTH the analyze leg and the commit leg — one place, one
 * cadence, one terminal-stop rule.
 *
 * A 404 or an "expired" status means the job aged out server-side → onExpired.
 * Polling stops as soon as a terminal status arrives (done / committed / error
 * / cancelled / expired) and whenever `enabled` goes false (the reducer moves
 * to a non-polling phase).
 *
 * Backoff: a step moves fast early and then plateaus, so we poll 1.5s for the
 * first ~20s of a step, 3s for the next ~20s, then 5s. The clock resets each
 * time the server's `step` changes, so every new stage gets tight polling
 * again.
 */
function pollDelay(msInStep: number): number {
  if (msInStep < 20_000) return 1500;
  if (msInStep < 40_000) return 3000;
  return 5000;
}

export function useIngestJob(opts: {
  jobId: string | null;
  enabled: boolean;
  onJob: (job: Job) => void;
  onExpired: () => void;
}): void {
  const { jobId, enabled } = opts;
  const onJob = useRef(opts.onJob);
  const onExpired = useRef(opts.onExpired);
  onJob.current = opts.onJob;
  onExpired.current = opts.onExpired;

  useEffect(() => {
    if (!jobId || !enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let stepKey: string | null | undefined;
    let stepSince = Date.now();

    const tick = async () => {
      try {
        const r = await fetch(`/api/ingest/${jobId}`, { cache: "no-store" });
        if (stopped) return;
        if (r.status === 404) { onExpired.current(); return; } // terminal: no reschedule
        const job: Job = await r.json();
        if (stopped) return;
        if (job.status === "expired") { onExpired.current(); return; }
        if (job.step !== stepKey) { stepKey = job.step; stepSince = Date.now(); }
        onJob.current(job);
        if (TERMINAL_STATUSES.has(job.status)) return;         // terminal: stop
      } catch {
        /* transient network error — fall through and retry */
      }
      if (!stopped) timer = setTimeout(tick, pollDelay(Date.now() - stepSince));
    };

    timer = setTimeout(tick, 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [jobId, enabled]);
}
