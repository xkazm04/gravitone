"use client";

// The console's "rendering" row and the clock that ticks inside it. Its own
// module because its whole reason for existing is to keep that tick OUT of the
// take log — see the doctrine on the component below.

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { RenderRail } from "./signal";

/** Human duration for the render clock: sub-minute renders read in tenths,
 *  longer ones (a CPU-only script render) in m:ss. */
function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/**
 * The "rendering" row, INCLUDING its ticking clock.
 *
 * The clock used to live in PlaygroundConsole, so every 250ms tick re-rendered
 * the whole take log — and each take card is an AnimatePresence `layout` child
 * that re-measures on every render. The clock only ever drew this one row, so
 * this is where its state belongs. Nothing about what is displayed changed.
 */
export function RenderStatus({ startedAt, etaSec, estAudioSec, etaBasisLabel, noEtaLabel, streamedSec, queued, inFlight, metricsUnavailable, healthStale, still }: {
  startedAt: number | null; etaSec: number | null; estAudioSec: number;
  etaBasisLabel: string; noEtaLabel: string;
  /** The visitor's reduced-motion preference, resolved once in the console and
   *  passed down — never read per-component (DESIGN.md motion rules). */
  still: boolean;
  // Seconds of audio ALREADY RECEIVED on a streaming render, or null when this
  // run is not streaming. An estimate is what you show when progress cannot be
  // observed; when it can, showing the estimate instead is a choice to guess in
  // front of a measurement.
  streamedSec: number | null;
  // null = the engine did not report this number. NOT the same as 0, which is
  // a real reading of an empty queue.
  queued: number | null; inFlight: number | null;
  metricsUnavailable: boolean; healthStale: boolean;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  // Keyed on startedAt, so a new run restarts the clock and unmounting (the run
  // finishing or being cancelled) clears the interval.
  useEffect(() => {
    if (startedAt === null) return;
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  const overEstimate = etaSec !== null && elapsedMs / 1000 > etaSec;

  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      className="glass-panel mb-2 rounded-xl px-5 py-4">
      <div className="flex items-center gap-4">
        <span className="font-jetbrains shrink-0 text-[11px] text-cyan-300">rendering</span>
        {/* Was 48 `.eq-bar` spans: a keyframe pretending to be levels, which
            reduced motion froze into a solid cyan block. A dash-draw of the
            wave being written has an honest still frame. */}
        <RenderRail still={still} />
        {/* The one MEASURED number on this row. */}
        <span className="font-jetbrains shrink-0 text-[12px] tabular-nums text-white/85" aria-live="off">
          {fmtElapsed(elapsedMs)}
        </span>
      </div>
      <p className="font-jetbrains mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/55">
        {/* An estimate presented as a measurement is a lie, so it is
            always labelled, always sourced, and when it is exceeded it
            says so instead of stalling at "1s remaining". */}
        {streamedSec !== null ? (
          <span className="text-cyan-200/85">
            Streaming — {streamedSec.toFixed(1)}s of audio received and playing. No estimate is
            needed: this is what has arrived, not a guess at what will.
          </span>
        ) : etaSec === null ? (
          <span>{noEtaLabel}</span>
        ) : overEstimate ? (
          <span className="text-amber-200/80">
            Past the ~{etaSec}s estimate — still rendering ({etaBasisLabel}; an estimate, not a measurement of this run).
          </span>
        ) : (
          <span>Estimated ~{etaSec}s for ~{estAudioSec}s of audio — {etaBasisLabel}.</span>
        )}
        {/* An ABSENT queue reading is not an empty queue. The engine gates its
            metrics behind the observability scope (service/app.py::health), so
            a studio with no API key against a keyed backend gets a bare
            {"status":"ready"} — coercing that to 0 made "we cannot see the
            queue" render identically to "the queue is empty", with nothing
            stale about it because the request succeeded. */}
        {metricsUnavailable ? (
          <span className="text-amber-200/70" title="The engine reports queue depth only to callers holding its observability scope — set GRAVITONE_API_KEY for this studio to see it">
            · queue depth unavailable to this studio — this is not a reading of an empty queue
          </span>
        ) : (
          <>
            {queued !== null && queued > 0 && (
              <span title="Jobs waiting for a synthesis worker across the engine">
                · {queued} job{queued === 1 ? "" : "s"} queued ahead of the pool
              </span>
            )}
            {inFlight !== null && inFlight > 0 && <span title="Jobs a worker is synthesizing right now">· {inFlight} rendering</span>}
            {/* Said out loud, so "nothing queued" is an affirmative reading
                rather than the absence of a chip. */}
            {queued === 0 && inFlight === 0 && (
              <span title="The engine reported an empty queue">· queue clear</span>
            )}
          </>
        )}
        {healthStale && <span className="text-amber-200/70">· queue reading is stale</span>}
      </p>
    </motion.div>
  );
}
