"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readDetail } from "@/lib/apiFetch";
import type { CastResult } from "./machine";

/**
 * The re-splice half of the Casting Board: POST /api/ingest/{job}/stems,
 * debounced, coalesced, and never overlapping itself.
 *
 * Why a hook and not a plain call per click: including a segment is a checkbox,
 * and a checkbox that fires a wav splice per keystroke-equivalent would send a
 * request per tick of a user sweeping down a list. Edits are merged into ONE
 * pending assignment map and sent once the clicking stops, so the seconds bar
 * settles on the real measurement rather than chasing four of them.
 *
 * Two things it deliberately does not do:
 *   * it never guesses the new length — `seconds`/`eligible` come back from the
 *     file the service wrote, and until they do the board says "re-splicing";
 *   * it never swallows a refusal. Every 400/409 on this path is a NAMED
 *     sentence about a specific segment or a specific stem, and it is surfaced
 *     verbatim next to the row that caused it.
 */
export const RESPLICE_DEBOUNCE_MS = 450;

export type CastingState = {
  /** A re-splice is in flight or waiting out the debounce. */
  busy: boolean;
  /** The service's own words for why the last edit was refused. */
  error: string | null;
};

export function useCasting(
  jobId: string | null,
  onSynced: (cast: CastResult) => void,
) {
  const [state, setState] = useState<CastingState>({ busy: false, error: null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queued = useRef<Record<string, number[]>>({});
  const alive = useRef(true);
  // The callback is read through a ref so a re-render of the page (which it
  // certainly will, on every edit) does not re-arm or cancel a pending splice.
  const synced = useRef(onSynced);
  useEffect(() => { synced.current = onSynced; }, [onSynced]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // A job change abandons anything queued for the previous recording: those
  // indices address segments in a workdir the service has already torn down.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      queued.current = {};
    };
  }, [jobId]);

  const send = useCallback(async (body: Record<string, unknown>) => {
    if (!jobId) return;
    setState({ busy: true, error: null });
    try {
      const r = await fetch(`/api/ingest/${jobId}/stems`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const detail = await readDetail(r);
        if (alive.current) {
          setState({ busy: false,
            error: detail ?? "these segments could not be re-spliced" });
        }
        return;
      }
      const cast = (await r.json()) as CastResult;
      if (!alive.current) return;
      setState({ busy: false, error: null });
      synced.current(cast);
    } catch {
      if (alive.current) {
        setState({ busy: false,
          error: "couldn't reach the studio to re-splice this stem" });
      }
    }
  }, [jobId]);

  /** Queue an edit. Merged with anything already waiting, sent once the user
   *  stops clicking. */
  const cast = useCallback((assignments: Record<string, number[]>) => {
    queued.current = { ...queued.current, ...assignments };
    setState((s) => ({ busy: true, error: s.error }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const body = queued.current;
      queued.current = {};
      timer.current = null;
      void send({ assignments: body });
    }, RESPLICE_DEBOUNCE_MS);
  }, [send]);

  /** Back to the splice the pipeline proposed. Immediate — a reset is a
   *  deliberate act, not a stream of them, and making the user wait out a
   *  debounce for it would read as a dead button. */
  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    queued.current = {};
    void send({ reset: true });
  }, [send]);

  const dismiss = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  return { ...state, cast, reset, dismiss };
}
