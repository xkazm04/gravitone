"use client";

// ── The emotion audition ─────────────────────────────────────────────────────
//
// One action, one line, every Voice this Character has. The claim it exists to
// make demonstrable: in Gravitone an emotion is a RECORDING, not a prompt, so
// hearing the whole scale on IDENTICAL text is the only honest way to check two
// things at once —
//
//   * the emotional range is real (the takes differ), and
//   * the speaker is still the same person in every one of them (the identity
//     does not drift the way an emotionally-prompted clone does).
//
// The single shared line is the whole experiment: change the text between
// emotions and the comparison proves nothing, so the line is one piece of state
// for the entire run and it is part of every cache key.
//
// Three rules carry the honesty here, and all three are about NOT lying while
// the backend is under load:
//
//   1. **Bounded concurrency.** The service admits a fixed number of syntheses
//      and answers 429 past it (`service/engine.py` admission + `errors.py`).
//      Firing eight previews at a CPU-only box would earn six refusals, so the
//      run walks the scale through a small pool instead.
//   2. **Backpressure is waited out, in public.** A 429 is not a failure — the
//      engine is up and told us when to come back. The cell shows a LIVE
//      countdown of the backend's own Retry-After and retries; it is never a
//      spinner, never a silent drop, and after `BUSY_RETRIES` attempts it
//      becomes a named failure rather than an infinite wait.
//   3. **Every cell owns its own outcome.** A failed emotion says why, in the
//      backend's words, against its own tile. One page-level banner over eight
//      tiles cannot say which one broke.
//
// Results are cached by (voice, line) for the tab's lifetime, so re-auditioning
// costs nothing and the A/B a user actually wants to do — play them back to
// back, repeatedly — never re-enters the queue.

import { useCallback, useEffect, useRef, useState } from "react";
import { throwDetail } from "@/lib/apiFetch";
import { EngineBusyError, isAbort, parseRetryAfter } from "@/lib/engineSeam";
import { useMounted } from "@/lib/useMounted";

/** The neutral line every emotion speaks. Deliberately affect-free: it carries
 *  no emotional cue of its own, so the ONLY variable between two takes is the
 *  Voice, which is the entire point of the comparison. */
export const AUDITION_LINE =
  "We should talk about what happens next, because it starts on Monday.";

/** How many previews may be in flight at once. Two, not eight: the service
 *  admits a bounded number of syntheses and 429s past it, and a wall of
 *  refusals is a worse first impression than a scale that fills in order. */
export const AUDITION_CONCURRENCY = 2;

/** How many times one cell waits out a 429 before it gives up and says so. */
export const BUSY_RETRIES = 4;

/**
 * One Voice to audition: the slot, and the concrete voice that speaks it.
 *
 * `derivedFrom` carries the slot's ORIGIN into the matrix, and it is not
 * cosmetic. The audition's claim is that the speaker never drifted, and a
 * computed take cannot support that claim about anybody — so the target has to
 * know which it is before a tile can be honest about it. Null (or absent) means
 * a human performed this take; a string names who the emotion direction came
 * from, in the rack's own words (`derivedDonorLabel`).
 */
export type AuditionTarget = {
  emotion: string;
  label: string;
  voiceId: string;
  derivedFrom?: string | null;
};

/**
 * What one tile is doing right now. There is no state that renders as a
 * spinner with no explanation: `waiting` carries the seconds left and which
 * attempt it is on, `failed` carries the reason.
 */
export type AuditionCell =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "rendering" }
  | { kind: "waiting"; seconds: number; attempt: number }
  | { kind: "ready"; cached: boolean }
  | { kind: "failed"; reason: string };

export type AuditionState = Record<string, AuditionCell>;

// ── the client-side cache ────────────────────────────────────────────────────
// Module-level on purpose: navigating from the rack to the recorder and back
// must not re-enter the synthesis queue for audio the tab already holds.
// Bounded (LRU) because each entry is a whole WAV and a long session across
// several Characters would otherwise pin every one of them in memory.

const CACHE_MAX = 32;
const CACHE = new Map<string, Blob>();

export function auditionKey(voiceId: string, line: string): string {
  return `${voiceId}\u0000${line}`;
}

/** The stored take for this (voice, line), or null. Refreshes LRU order. */
export function cachedAudition(voiceId: string, line: string): Blob | null {
  const key = auditionKey(voiceId, line);
  const blob = CACHE.get(key);
  if (!blob) return null;
  CACHE.delete(key);
  CACHE.set(key, blob); // most-recently-used
  return blob;
}

export function storeAudition(voiceId: string, line: string, blob: Blob): void {
  const key = auditionKey(voiceId, line);
  CACHE.delete(key);
  CACHE.set(key, blob);
  while (CACHE.size > CACHE_MAX) {
    const oldest = CACHE.keys().next();
    if (oldest.done) break;
    CACHE.delete(oldest.value);
  }
}

/** Test seam. Never called by the app — a user emptying this cache would only
 *  make their next audition slower for no stated benefit. */
export function clearAuditionCache(): void {
  CACHE.clear();
}

// ── the render ───────────────────────────────────────────────────────────────

/**
 * Synthesize ONE line in ONE voice through the existing playground proxy.
 *
 * No new backend surface: `/api/tts` already takes a concrete voice id and
 * passes the engine's status through untouched (429 with its Retry-After
 * included), which is exactly what an honest audition needs. Every slot in the
 * rack already knows the voice that speaks it, so emotion addressing is not
 * needed either — this asks for the very embedding the row displays.
 */
export async function renderAudition(
  voiceId: string, line: string, signal?: AbortSignal,
): Promise<Blob> {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: line, voiceId }),
    signal,
  });
  if (r.status === 429) {
    // Backpressure, not breakage — thrown distinctly so the runner waits it
    // out instead of burning the cell on a refusal the engine invited us to
    // retry.
    throw new EngineBusyError(parseRetryAfter(r.headers.get("Retry-After")));
  }
  if (!r.ok) await throwDetail(r, `preview failed (${r.status})`);
  return r.blob();
}

function reasonOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "the preview failed";
}

/** A cancellable sleep. Resolves early (and reports false) when aborted, so a
 *  stopped run never leaves a timer holding the pool open. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(id);
      resolve(false);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type AuditionDeps = {
  /** Injected so the runner is testable without a network. */
  render?: (voiceId: string, line: string, signal: AbortSignal) => Promise<Blob>;
  concurrency?: number;
  busyRetries?: number;
};

/**
 * Audition every target on the same line, honouring backpressure out loud.
 *
 * `set` is called for every state transition of every cell — the caller owns
 * the rendering, this owns the truth. Resolves when the whole scale has
 * settled (ready or failed) or the run was aborted; it never rejects, because
 * a failure belongs on the tile that earned it, not on the run.
 */
export async function runAudition(
  targets: AuditionTarget[],
  line: string,
  signal: AbortSignal,
  set: (emotion: string, cell: AuditionCell) => void,
  deps: AuditionDeps = {},
): Promise<void> {
  const render = deps.render ?? renderAudition;
  const busyRetries = deps.busyRetries ?? BUSY_RETRIES;
  const queue = [...targets];
  for (const t of queue) set(t.emotion, { kind: "queued" });

  async function one(t: AuditionTarget): Promise<void> {
    const hit = cachedAudition(t.voiceId, line);
    if (hit) {
      // Free, and SAID to be free: a user who just re-auditioned should be able
      // to see that nothing was re-rendered, or the "previews are rendered once"
      // claim is only in the docs.
      set(t.emotion, { kind: "ready", cached: true });
      return;
    }
    for (let attempt = 0; ; attempt++) {
      set(t.emotion, { kind: "rendering" });
      try {
        const blob = await render(t.voiceId, line, signal);
        storeAudition(t.voiceId, line, blob);
        set(t.emotion, { kind: "ready", cached: false });
        return;
      } catch (e) {
        if (isAbort(e) || signal.aborted) {
          set(t.emotion, { kind: "idle" });
          return;
        }
        if (e instanceof EngineBusyError && attempt < busyRetries) {
          // Wait the backend's own Retry-After, counting down where the user
          // can see it. A queue-full that silently became "failed" would blame
          // the voice for a load condition.
          for (let left = e.retryAfterSec; left > 0; left--) {
            set(t.emotion, { kind: "waiting", seconds: left, attempt: attempt + 1 });
            if (!(await sleep(1000, signal))) {
              set(t.emotion, { kind: "idle" });
              return;
            }
          }
          continue;
        }
        set(t.emotion, {
          kind: "failed",
          reason: e instanceof EngineBusyError
            // The retries are spent. Name the real cause — "the engine stayed
            // full" is actionable in a way that "failed" is not.
            ? `the engine stayed at capacity after ${busyRetries} retries`
            : reasonOf(e),
        });
        return;
      }
    }
  }

  const lanes = Math.max(1, Math.min(deps.concurrency ?? AUDITION_CONCURRENCY, queue.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const t = queue.shift();
        if (!t) return;
        if (signal.aborted) {
          // Everything still unstarted goes back to idle rather than sitting on
          // "queued" forever — a cancelled run must leave no cell mid-sentence.
          set(t.emotion, { kind: "idle" });
          continue;
        }
        await one(t);
      }
    }),
  );
}

// ── the hook ─────────────────────────────────────────────────────────────────

/**
 * Drive one Character's audition: the run, the per-cell state, and ONE audio
 * element for the whole matrix.
 *
 * One transport by construction. Eight tiles each minting their own `Audio`
 * would let two emotions overlap, which is precisely the comparison this
 * feature exists to make — and it would make it wrong.
 */
export function useEmotionAudition(targets: AuditionTarget[], deps: AuditionDeps = {}) {
  const [line, setLine] = useState(AUDITION_LINE);
  const [cells, setCells] = useState<AuditionState>({});
  const [running, setRunning] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  /** A playback refusal (autoplay policy, an undecodable blob). Kept apart from
   *  the cell state: the take rendered fine and is still there, so downgrading
   *  it to "failed" would name the wrong thing. */
  const [playError, setPlayError] = useState<{ emotion: string; reason: string } | null>(null);

  const mounted = useMounted();
  const runRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const setCell = useCallback((emotion: string, cell: AuditionCell) => {
    if (!mounted.current) return;
    setCells((prev) => ({ ...prev, [emotion]: cell }));
  }, [mounted]);

  const stopRun = useCallback(() => {
    runRef.current?.abort();
    runRef.current = null;
  }, []);

  const audition = useCallback(async () => {
    if (runRef.current) return; // in-flight gate: a second click must not
                                //   double-queue the whole scale
    if (targets.length === 0) return;
    const ctrl = new AbortController();
    runRef.current = ctrl;
    setRunning(true);
    setPlayError(null);
    try {
      await runAudition(targets, line, ctrl.signal, setCell, deps);
    } finally {
      if (runRef.current === ctrl) runRef.current = null;
      if (mounted.current) setRunning(false);
    }
    // `deps` is a plain object literal at every call site; depending on it
    // would re-create this callback on every render and break the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, line, setCell, mounted]);

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    audioRef.current?.pause();
    revoke();
    setPlaying(null);
  }, [revoke]);

  const play = useCallback(async (t: AuditionTarget) => {
    if (playing === t.emotion) return stopPlayback();
    stopPlayback();
    setPlayError(null);
    const blob = cachedAudition(t.voiceId, line);
    if (!blob) {
      // The tile only offers play once a take exists, so this is a cache that
      // was evicted underneath the UI. Say that, and put the tile back to a
      // state whose button re-renders it.
      setCell(t.emotion, { kind: "idle" });
      setPlayError({ emotion: t.emotion, reason: "that take is no longer held — audition again" });
      return;
    }
    const url = URL.createObjectURL(blob);
    if (!audioRef.current) audioRef.current = new Audio();
    const a = audioRef.current;
    urlRef.current = url;
    a.src = url;
    a.onended = () => { revoke(); if (mounted.current) setPlaying(null); };
    try {
      await a.play();
    } catch (e) {
      revoke();
      if (!mounted.current) return;
      setPlaying(null);
      // The browser's own sentence — an autoplay refusal tells the user to
      // click, which "playback failed" does not.
      setPlayError({ emotion: t.emotion, reason: reasonOf(e) });
      return;
    }
    if (!mounted.current) { revoke(); return; }
    setPlaying(t.emotion);
  }, [playing, line, stopPlayback, revoke, setCell, mounted]);

  // A new line is a new experiment: the old cells describe takes of different
  // text, and leaving them on screen would invite exactly the invalid
  // comparison this module exists to prevent. The CACHE keeps the old takes —
  // typing the line back replays them for free.
  const editLine = useCallback((next: string) => {
    stopRun();
    stopPlayback();
    setLine(next);
    setCells({});
    setPlayError(null);
  }, [stopRun, stopPlayback]);

  useEffect(() => () => {
    runRef.current?.abort();
    audioRef.current?.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  return { line, editLine, cells, running, playing, playError,
           audition, stopRun, play, stopPlayback };
}

/** How the run reads as one sentence — rendered once, above the matrix. */
export function auditionSummary(cells: AuditionState, total: number): {
  ready: number; failed: number; waiting: number; pending: number;
} {
  let ready = 0, failed = 0, waiting = 0, pending = 0;
  for (const cell of Object.values(cells)) {
    if (cell.kind === "ready") ready++;
    else if (cell.kind === "failed") failed++;
    else if (cell.kind === "waiting") waiting++;
    else if (cell.kind === "queued" || cell.kind === "rendering") pending++;
  }
  // `total` is the caller's target count; anything not in `cells` is untouched
  // and deliberately counted as nothing rather than as a success.
  void total;
  return { ready, failed, waiting, pending };
}
