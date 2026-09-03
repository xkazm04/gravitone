"use client";

import { useEffect, useRef, useState } from "react";
import type { useMounted } from "@/lib/useMounted";
import { startRederive } from "@/app/voices/new/_state/corpus";
import { useIngestJob } from "@/app/voices/new/_state/useIngestJob";
import type { Job } from "@/app/voices/new/_state/machine";

/** Rebuilding this character's voices from everything kept — as a polled job. */
export function useCorpusRebuild(
  characterId: string,
  mounted: ReturnType<typeof useMounted>,
  onRebuilt?: () => void,
) {
  // ── re-derivation ───────────────────────────────────────────────────────────
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [rederiveError, setRederiveError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [stalled, setStalled] = useState(false);
  const announced = useRef(false);

  const done = job?.status === "committed";
  const failed = job?.status === "error";
  const stopped = job?.status === "cancelled" || expired;
  useIngestJob({
    jobId,
    // The same poller the studio uses for the analyze and commit legs: one
    // cadence, one terminal-stop rule, one 404-means-expired answer.
    enabled: Boolean(jobId) && !done && !failed && !stopped,
    onJob: setJob,
    onExpired: () => setExpired(true),
    onStalled: setStalled,
  });

  // The rebuild REPLACED voices, so the page above is showing stale ones. Fire
  // once, on the transition into 'committed'.
  useEffect(() => {
    if (!done || announced.current) return;
    announced.current = true;
    onRebuilt?.();
  }, [done, onRebuilt]);

  const kicking = useRef(false); // atomic gate — see `removing` above

  async function rebuild() {
    if (kicking.current || (jobId && !done && !failed && !stopped)) return;
    kicking.current = true;
    setStarting(true);
    setRederiveError(null); setExpired(false); setJob(null); setStalled(false);
    announced.current = false;
    try {
      const started = await startRederive(characterId);
      if (!mounted.current) return;
      setJobId(started.job_id);
    } catch (e) {
      if (!mounted.current) return;
      // 404 (nothing kept), 409 (over cap / nothing matched) and 429 all arrive
      // here as the service's own sentence — that is the whole reason the
      // refusals are synchronous.
      setRederiveError(e instanceof Error ? e.message : "the rebuild could not be started");
    } finally {
      kicking.current = false;
      if (mounted.current) setStarting(false);
    }
  }

  const busyRebuilding = Boolean(jobId) && !done && !failed && !stopped;

  return { starting, job, rederiveError, stalled, done, failed, stopped, busyRebuilding, rebuild };
}
