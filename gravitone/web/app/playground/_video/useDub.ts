"use client";

// One dub, owned by the console. Both directions of the re-voice round call
// this — they disagree about where the LINES live, never about what a dub is.
//
// The backend door is stateless by design (service/revoice_api.py): it takes
// the source link plus the lines with their absolute timing, so nothing here
// depends on an ingest job still being alive on the box. `run` is handed the
// lines by whoever owns them, which is exactly the thing the round is choosing
// between.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/apiFetch";
import { cancelJob, submitRevoice, useStudioJob, type RevoiceFit } from "./videoData";

export type DubLine = {
  id: string;
  characterId: string;
  text: string;
  start: number;
  end: number;
};

/** A line paired with what the last run did to it. */
export type DubSlot = { line: DubLine; fit: RevoiceFit | null };

/** Seconds a slot gets when nothing has said otherwise. Short enough that the
 *  fit ladder is a real question on the first run rather than a formality. */
const DEFAULT_SLOT_S = 4;
const DEFAULT_GAP_S = 0.5;

export function useDub() {
  const [url, setUrl] = useState("");
  // Both default ON: they are what makes this more than a batch of takes —
  // the brain composes the emotional read and shortens what cannot fit. Each
  // change is reported per line, so neither is a silent liberty.
  const [direct, setDirect] = useState(true);
  const [rewrite, setRewrite] = useState(true);
  const [timing, setTiming] = useState<Record<string, { start: number; end: number }>>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The lines that produced the CURRENT job. Fit comes back indexed by
  // position in what was sent, so pairing it to whatever is on screen now
  // would mis-attribute every verdict the moment a line is added or moved.
  const [submitted, setSubmitted] = useState<DubLine[]>([]);
  const { job, stalled } = useStudioJob("revoice", jobId);
  // Every `await` below is followed by a setState; the guard is what keeps a
  // dub submitted just before a tab switch from writing into a dead tree.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** Fill in the slots nothing has set yet: each line follows the one before
   *  it. Deterministic, so a sheet does not reshuffle itself as it is edited. */
  const slotsFor = useCallback(
    (ids: string[]): Record<string, { start: number; end: number }> => {
      const out: Record<string, { start: number; end: number }> = {};
      let clock = 0;
      for (const id of ids) {
        const held = timing[id];
        const start = held?.start ?? clock;
        const end = held?.end ?? start + DEFAULT_SLOT_S;
        out[id] = { start, end };
        clock = end + DEFAULT_GAP_S;
      }
      return out;
    },
    [timing],
  );

  const patchTiming = useCallback((id: string, p: { start?: number; end?: number }) => {
    setTiming((t) => {
      const cur = t[id] ?? { start: 0, end: DEFAULT_SLOT_S };
      return { ...t, [id]: { ...cur, ...p } };
    });
  }, []);

  /** Why this dub cannot run yet, in a sentence — never a silently dead
   *  button. Order matters: the source, then the words, then the clock. */
  const blockedFor = useCallback((lines: DubLine[]): string | null => {
    if (!url.trim()) return "paste a link to the video whose dialogue you are replacing";
    if (lines.length === 0) return "write at least one line to put in it";
    if (lines.some((l) => !l.text.trim())) return "every line needs words — an empty line has nothing to dub";
    if (lines.some((l) => !l.characterId)) return "every line needs a Character to speak it";
    if (lines.some((l) => l.end <= l.start)) return "every line needs an out later than its in";
    return null;
  }, [url]);

  const run = useCallback(async (lines: DubLine[]) => {
    if (submitting || blockedFor(lines)) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await submitRevoice({
        url: url.trim(),
        lines: lines.map((l) => ({
          character_id: l.characterId,
          text: l.text.trim(),
          start: l.start,
          end: l.end,
        })),
        direct,
        rewrite,
      });
      if (!mounted.current) return;
      setSubmitted(lines);
      setJobId(res.job_id);
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof ApiError ? e.message : "the dub could not be started");
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }, [submitting, blockedFor, url, direct, rewrite]);

  const reset = useCallback(async () => {
    const id = jobId;
    const running = job?.status === "running";
    setJobId(null);
    setSubmitted([]);
    setError(null);
    if (id && running) await cancelJob("revoice", id);
  }, [jobId, job?.status]);

  const fits = useMemo(
    () => (job?.result?.fit ?? []) as RevoiceFit[],
    [job?.result],
  );

  /** What the last run did to THIS line, or null if it was not in it. Paired
   *  by id through `submitted`, so an edit after a run cannot make a verdict
   *  describe words that never produced it. */
  const fitFor = useCallback((lineId: string): RevoiceFit | null => {
    const at = submitted.findIndex((l) => l.id === lineId);
    return at < 0 ? null : (fits[at] ?? null);
  }, [submitted, fits]);

  /** The run's own lines, paired with their verdicts — the ribbon's source of
   *  truth, unaffected by whatever is being edited now. */
  const slots = useMemo<DubSlot[]>(
    () => submitted.map((line, i) => ({ line, fit: fits[i] ?? null })),
    [submitted, fits],
  );

  return {
    url, setUrl,
    direct, setDirect, rewrite, setRewrite,
    timing, slotsFor, patchTiming,
    jobId, job, stalled, submitting, error,
    run, reset, blockedFor, fitFor, slots,
    ready: job?.status === "done",
  };
}

export type Dub = ReturnType<typeof useDub>;
