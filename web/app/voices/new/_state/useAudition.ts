"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readDetail } from "@/lib/apiFetch";

/**
 * Fetches auditions — POST /api/ingest/{job}/audition — and holds the resulting
 * clips as blob URLs so a take can be replayed, and A/B'd against another, with
 * no second synthesis.
 *
 * Why a cache and not a plain fetch per play: each audition is a real CPU model
 * load in a child process (tens of seconds). An A/B where clicking "X" again
 * re-synthesized X would be unusable, and would spend the backend's audition
 * budget on audio the browser already has. Blob URLs are revoked on unmount and
 * whenever the job changes, so the clips of an abandoned recording do not
 * outlive it.
 *
 * A 429 is backpressure, exactly as the page treats it everywhere else: the
 * audition budget is full, nothing failed, and `busySec` says how long the
 * backend asked us to wait.
 */
export type Take = {
  loading: boolean;
  url?: string;
  seconds?: number;
  error?: string;
  busySec?: number;
};

export function takeKey(emotion: string, recipe: string, text: string): string {
  return `${emotion}|${recipe}|${text.trim()}`;
}

export function useAudition(jobId: string | null) {
  const [takes, setTakes] = useState<Record<string, Take>>({});
  const urls = useRef<string[]>([]);
  const inflight = useRef<Set<string>>(new Set());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // One place that frees blob URLs: a job change and unmount both mean every
  // clip we hold belongs to a recording nobody is looking at any more.
  useEffect(() => {
    return () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
      inflight.current.clear();
    };
  }, [jobId]);

  const request = useCallback(async (
    emotion: string, recipe: string, text: string,
  ): Promise<string | null> => {
    if (!jobId) return null;
    const key = takeKey(emotion, recipe, text);
    const have = takes[key];
    if (have?.url) return have.url;
    if (inflight.current.has(key)) return null;   // one synthesis per take
    inflight.current.add(key);
    setTakes((t) => ({ ...t, [key]: { loading: true } }));
    try {
      const r = await fetch(`/api/ingest/${jobId}/audition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emotion, recipe, text: text.trim() }),
      });
      if (r.status === 429) {
        const raw = Number(r.headers.get("Retry-After"));
        const busySec = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 5;
        const detail = await readDetail(r);
        if (alive.current) {
          setTakes((t) => ({ ...t, [key]: { loading: false, busySec,
            error: detail ?? "the audition queue is busy" } }));
        }
        return null;
      }
      if (!r.ok) {
        const detail = await readDetail(r);
        if (alive.current) {
          setTakes((t) => ({ ...t, [key]: { loading: false,
            error: detail ?? "this take could not be synthesized" } }));
        }
        return null;
      }
      const seconds = Number(r.headers.get("X-Audition-Seconds"));
      const url = URL.createObjectURL(await r.blob());
      if (!alive.current) { URL.revokeObjectURL(url); return null; }
      urls.current.push(url);
      setTakes((t) => ({ ...t, [key]: { loading: false, url,
        seconds: Number.isFinite(seconds) ? seconds : undefined } }));
      return url;
    } catch {
      if (alive.current) {
        setTakes((t) => ({ ...t, [key]: { loading: false,
          error: "couldn't reach the studio to synthesize this take" } }));
      }
      return null;
    } finally {
      inflight.current.delete(key);
    }
  }, [jobId, takes]);

  return { takes, request };
}
