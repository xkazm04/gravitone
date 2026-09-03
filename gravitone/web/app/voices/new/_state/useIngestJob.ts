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
 * Transport failures (network down, proxy 5xx) retry forever — the job is
 * durable server-side, so giving up would abandon real progress — but they are
 * no longer invisible: after STALL_AFTER consecutive failures `onStalled(true)`
 * fires so the page can say the connection is degraded instead of animating a
 * healthy-looking loader; the first successful poll fires `onStalled(false)`.
 *
 * Backoff: a step moves fast early and then plateaus, so we poll 1.5s for the
 * first ~20s of a step, 3s for the next ~20s, then 5s. The clock resets each
 * time the server's `step` changes, so every new stage gets tight polling
 * again. A hidden tab drops to HIDDEN_MS and returning to it polls immediately.
 *
 * Every request is CONDITIONAL (If-None-Match against the last ETag). A job's
 * payload carries its whole result — stems, casting, and every segment with its
 * text — and it is re-shipped, re-parsed and re-dispatched on every poll, while
 * the committing screen reads three integers off `partial`. An unchanged job
 * now answers 304 with no body, and the hook keeps what it has.
 *
 * WATCH MODE (`watch: true`) is the review screen's leg, and it is a different
 * job: nothing is progressing, so there is nothing to follow — but the service
 * ages a job from its last state MUTATION on a 30-minute idle TTL, and a GET is
 * not one (see WATCH_PHASES in machine.ts). So we ask once every WATCH_MS for
 * exactly one fact: is this session still there. Consequences of that being the
 * only question:
 *   * a terminal status does NOT stop the loop (review IS the terminal status);
 *   * the payload is deliberately NOT handed to `onJob`. The ledger on screen
 *     is the one the user is editing — re-seeding it from a poll would throw
 *     away their selections, their auditions and their casting every 30s;
 *   * a job that has gone (404) or that the server itself reports as
 *     expired/cancelled ends the flow, which is the whole point.
 */
function pollDelay(msInStep: number): number {
  if (msInStep < 20_000) return 1500;
  if (msInStep < 40_000) return 3000;
  return 5000;
}

const STALL_AFTER = 3; // consecutive failed polls before the UI is told
/** Watch cadence. The TTL it guards is 30 minutes, so "within a minute" is
 *  plenty of resolution and costs ~2 requests a minute for an idle screen. */
export const WATCH_MS = 30_000;

/**
 * Cadence for a tab nobody is looking at.
 *
 * useHealthPoll STOPS while hidden, and that is right for it: it renders a
 * number, and a number can be refreshed on return. This poller cannot stop —
 * it drives a TERMINAL transition, so a backgrounded tab that stopped polling
 * would never learn its commit finished, and would sit on "cloning voices ·
 * 2/5" until the user clicked back. So hidden slows to the slowest cadence
 * this hook has, and becoming visible polls IMMEDIATELY rather than serving a
 * progress bar from before the tab went away.
 */
export const HIDDEN_MS = WATCH_MS;

const isHidden = () => typeof document !== "undefined" && document.hidden;

export function useIngestJob(opts: {
  jobId: string | null;
  enabled: boolean;
  /** Watch for expiry only — see WATCH MODE above. */
  watch?: boolean;
  onJob: (job: Job) => void;
  onExpired: () => void;
  onStalled?: (stalled: boolean) => void;
}): void {
  const { jobId, enabled, watch = false } = opts;
  const onJob = useRef(opts.onJob);
  const onExpired = useRef(opts.onExpired);
  const onStalled = useRef(opts.onStalled);
  onJob.current = opts.onJob;
  onExpired.current = opts.onExpired;
  onStalled.current = opts.onStalled;

  useEffect(() => {
    if (!jobId || !enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let stepKey: string | null | undefined;
    let stepSince = Date.now();
    let failures = 0;
    // The last payload's ETag. The proxy hashes the upstream body, so an
    // unchanged job answers 304 with no body at all — which is most polls of a
    // long step, and ALL of them in watch mode.
    let etag: string | null = null;

    const tick = async () => {
      try {
        const r = await fetch(`/api/ingest/${jobId}`, {
          cache: "no-store",
          headers: etag ? { "If-None-Match": etag } : undefined,
        });
        if (stopped) return;
        if (r.status === 404) { onExpired.current(); return; } // terminal: no reschedule
        if (r.status === 304) {
          // Nothing about the job changed. That is a SUCCESSFUL poll — the
          // connection is fine and the state on screen is current — so it
          // clears a stall and reschedules, and touches nothing else.
          if (failures >= STALL_AFTER) onStalled.current?.(false);
          failures = 0;
          if (!stopped) schedule();
          return;
        }
        // A 5xx body must not be coerced into a Job — treat it as a failed poll.
        if (!r.ok) throw new Error(`poll failed (${r.status})`);
        etag = r.headers.get("ETag");
        const job: Job = await r.json();
        if (stopped) return;
        if (failures >= STALL_AFTER) onStalled.current?.(false);
        failures = 0;
        if (job.status === "expired") { onExpired.current(); return; }
        if (watch) {
          // A session torn down elsewhere (another tab's DELETE) reports itself
          // cancelled rather than 404ing until GC runs — same outcome for the
          // user, so it ends the flow the same way.
          if (job.status === "cancelled") { onExpired.current(); return; }
          // Deliberately no onJob: see WATCH MODE. Keep watching.
        } else {
          if (job.step !== stepKey) { stepKey = job.step; stepSince = Date.now(); }
          onJob.current(job);
          if (TERMINAL_STATUSES.has(job.status)) return;       // terminal: stop
        }
      } catch {
        // transient transport error — retry, but stop pretending all is well
        if (stopped) return;
        failures += 1;
        if (failures === STALL_AFTER) onStalled.current?.(true);
      }
      if (!stopped) schedule();
    };

    /** The next wait. Hidden always wins: a backgrounded tab keeps following a
     *  terminal transition, it just stops paying 1.5s for it. */
    function schedule() {
      clearTimeout(timer);
      const delay = isHidden()
        ? HIDDEN_MS
        : watch ? WATCH_MS : pollDelay(Date.now() - stepSince);
      timer = setTimeout(tick, delay);
    }

    const onVisibility = () => {
      if (stopped) return;
      // Going away re-arms the PENDING wait at the hidden cadence too — a tab
      // hidden a moment after a poll should not fire again 1.5s later.
      if (isHidden()) { schedule(); return; }
      // Back on screen: ask NOW. Whatever is on the loader is from before the
      // tab went away, and the answer may be that the job finished minutes ago.
      clearTimeout(timer);
      timer = setTimeout(tick, 0);
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    timer = setTimeout(tick, isHidden() ? HIDDEN_MS : watch ? WATCH_MS : 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [jobId, enabled, watch]);
}
