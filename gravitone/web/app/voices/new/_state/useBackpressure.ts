"use client";

import { useEffect, useState, type MutableRefObject } from "react";
import { readDetail } from "@/lib/apiFetch";

// Backpressure, not failure: /scan, /speaker and /commit all pass through the
// ingest admission gate (service/ingest_api.py::_admit), which answers 429 when
// too many recordings are already being processed. Same shape the playground
// uses for the engine's 429 (PlaygroundConsole busyNotice + Retry-After
// countdown) — amber, with a retry that waits out the backoff window.
export type Backpressure = {
  detail: string;
  retryAfterSec: number;
  stated: boolean;   // did the response actually carry a Retry-After?
  action: { kind: "scan" } | { kind: "link" } | { kind: "speaker"; sid: string }
    | { kind: "cast" } | { kind: "commit" };
};

/** Retry-After (delta-seconds form) → a number; 1s when it is absent/bad. */
export function retryAfterOf(r: Response): { sec: number; stated: boolean } {
  const raw = r.headers.get("Retry-After");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? { sec: Math.ceil(n), stated: true }
    : { sec: 1, stated: false };
}

/**
 * The ingest admission gate's 429, held as its own fact with its own countdown.
 * `clearError` is the flow's rose channel: presenting backpressure always
 * clears it, because a full queue is not a failure of the recording.
 */
export function useBackpressure(opts: {
  mounted: MutableRefObject<boolean>;
  clearError: () => void;
}) {
  const { mounted, clearError } = opts;
  // 429 from the ingest admission gate. Recoverable, so it never becomes the
  // rose `error` — a full queue is "try again in a moment", not "it failed".
  const [notice, setNotice] = useState<Backpressure | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  useEffect(() => {
    if (!notice) { setRetryIn(0); return; }
    setRetryIn(notice.retryAfterSec);
    const id = setInterval(() => setRetryIn((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [notice]);

  /** Present a 429 as backpressure. Never touches `error` — that is rose. */
  async function present(r: Response, action: Backpressure["action"]) {
    const { sec, stated } = retryAfterOf(r);
    const detail = await readDetail(r);
    if (!mounted.current) return;
    clearError();
    setNotice({
      detail: detail ?? "other recordings are already being processed",
      retryAfterSec: sec, stated, action,
    });
  }

  function clear() { setNotice(null); }

  return { notice, retryIn, present, clear };
}
