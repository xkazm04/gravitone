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
 */
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

    const iv = setInterval(async () => {
      try {
        const r = await fetch(`/api/ingest/${jobId}`, { cache: "no-store" });
        if (stopped) return;
        if (r.status === 404) { stop(); onExpired.current(); return; }
        const job: Job = await r.json();
        if (stopped) return;
        if (job.status === "expired") { stop(); onExpired.current(); return; }
        onJob.current(job);
        if (TERMINAL_STATUSES.has(job.status)) stop();
      } catch {
        /* transient network error — keep polling */
      }
    }, 1500);

    function stop() { stopped = true; clearInterval(iv); }
    return stop;
  }, [jobId, enabled]);
}
