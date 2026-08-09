"use client";

// THE RUN — everything that happens between pressing Generate and a take
// landing in the log: the cancellable request, the render clock, the streaming
// progress, backpressure, and every notice a run is allowed to leave behind.

import { useEffect, useRef, useState } from "react";
import type { useMounted } from "@/lib/useMounted";
import type { OutputFormat } from "@/lib/audioFormats";
import {
  stripTags, TAKE_TIMING_VERSION,
  type Expression, type PerfLine, type ScriptLine, type Segment, type Take,
} from "./playgroundHelpers";
// `speakStreaming` rather than `speak`: it IS the solo path now, and its own
// policy is to take the buffered call for every request that may not honestly
// be streamed. PunchIn still imports `speak` directly — a fragment re-render
// needs the finished bytes to splice, so early playback buys it nothing.
import {
  speakStreaming, createStreamPlayer, perform,
  EngineBusyError, isAbort, type FallbackReason, type StreamPlayer,
} from "./playgroundEngine";
import type { Character } from "@/app/voices/_data/characters";

// What to tell the user when a take came from the browser voice. Each string
// names the ACTUAL cause; "unreachable" is no longer the catch-all.
//
// Each one ends by naming what was actually heard. The fallback is a genuine
// demo aid — a studio that goes mute the moment the engine is down is worse —
// but someone evaluating this product with no service running will hear their
// OPERATING SYSTEM's voice, and every one of these sentences has to make it
// impossible to mistake that for Gravitone's output.
const NOT_GRAVITONE = " What you just heard is your operating system's built-in speech, NOT Gravitone.";

const FALLBACK_COPY: Record<"unreachable" | "draining" | "failed", string> = {
  unreachable:
    "Gravitone backend unreachable — speaking with your browser voice (metatags ignored)." + NOT_GRAVITONE,
  draining:
    "Gravitone is restarting — spoke with your browser voice (metatags ignored). Try again in a moment." + NOT_GRAVITONE,
  failed:
    "Gravitone is reachable but synthesis failed — spoke with your browser voice (metatags ignored)." + NOT_GRAVITONE,
};

export function usePlaygroundGenerate({
  mode, text, plain, expr, format, character, scriptLines, charName,
  addTake, setAnnouncement, seq, mounted,
}: {
  mode: "solo" | "script";
  text: string;
  plain: string;
  expr: Expression;
  format: OutputFormat;
  character: Character | undefined;
  scriptLines: ScriptLine[];
  charName: (id: string) => string;
  addTake: (t: Take) => void;
  setAnnouncement: (s: string) => void;
  /** The take-id sequence, shared with the punch-in commit so two takes minted
   *  in the same millisecond cannot collide. */
  seq: { current: number };
  mounted: ReturnType<typeof useMounted>;
}) {
  const [busy, setBusy] = useState(false);
  // Backpressure (429): engine is up but busy — offer a retry, never fall to
  // the browser voice. null = no pending backpressure.
  const [busyNotice, setBusyNotice] = useState<{ retryAfterSec: number } | null>(null);
  // Seconds left on the backend's Retry-After. The retry button used to fire
  // instantly into the same full queue even though the wait was known.
  const [retryIn, setRetryIn] = useState(0);
  // Render clock: when the in-flight run started, and the ticking elapsed time.
  // A CPU-only render takes seconds or minutes and the console showed the same
  // decorative equalizer for both.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Seconds of audio received so far on a streaming solo render (null = this
  // run is not streaming, which is every script take, every mp3 and every take
  // carrying [emotion] tags — see lib/engineSeam::canStream).
  const [streamedSec, setStreamedSec] = useState<number | null>(null);
  // Transient error surface so generation failures are never silent.
  const [toast, setToast] = useState<string | null>(null);
  // Why the LAST generation dropped to the browser voice (null = it didn't).
  // Derived from the take list this used to scan for *any* browser take ever
  // made, so the banner stayed pinned across later successful renders and
  // across a session restore.
  const [fallback, setFallback] = useState<{ reason: FallbackReason; detail?: string } | null>(null);
  // In-flight generation, so it can be cancelled (or aborted on unmount).
  const runRef = useRef<AbortController | null>(null);
  // The scheduler playing a streamed take while it is still being made. Held so
  // a cancel (or leaving the page) can cut what is already scheduled: audio
  // that outlives the run that produced it is the worst thing this feature
  // could ship.
  const streamRef = useRef<StreamPlayer | null>(null);

  // The LAST run decides the notice: a 500 and an unplugged backend both drop
  // to the browser voice, but they are different events — and once a gravitone
  // take succeeds the notice is simply no longer true.
  const fallbackNotice = fallback && (
    fallback.detail
      ? `${FALLBACK_COPY[fallback.reason]} Backend said: ${fallback.detail}`
      : FALLBACK_COPY[fallback.reason]
  );

  /** Start a cancellable run, replacing any previous controller.
   *  CPU synthesis of a long script can take minutes on a loaded box; without
   *  a cancel the user can only wait or reload (HeroMicDemo added an abort for
   *  this exact backend — the playground, where people generate repeatedly,
   *  had none). */
  function newRun(): AbortController {
    const ctrl = new AbortController();
    runRef.current = ctrl;
    return ctrl;
  }

  /** Abort the in-flight generation. */
  function cancelGenerate() {
    runRef.current?.abort();
    runRef.current = null;
    streamRef.current?.stop();
    streamRef.current = null;
  }

  // Abort on unmount too: navigating away should not leave a synthesis
  // request holding a worker slot for a page nobody is looking at.
  useEffect(() => () => { runRef.current?.abort(); streamRef.current?.stop(); }, []);

  // Count the backend's Retry-After down so the retry button can wait for it.
  useEffect(() => {
    if (!busyNotice) { setRetryIn(0); return; }
    setRetryIn(busyNotice.retryAfterSec);
    const id = setInterval(() => setRetryIn((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [busyNotice]);

  /** Every generation starts from a clean slate of notices — a warning about
   *  the PREVIOUS run must never be read as a verdict on this one. */
  function clearNotices() {
    setBusyNotice(null);
    setToast(null);
    setFallback(null);
    setAnnouncement("");        // the PREVIOUS take's announcement is spent
    setStartedAt(Date.now());   // starts the render clock for this run
    setStreamedSec(null);       // ...and no audio has arrived for it yet
  }

  /** Report a generation failure with what the backend actually said. Errors
   *  from the apiFetch contract carry the sanitized `detail` (request id
   *  included), which is exactly what support needs and what the old single
   *  generic sentence destroyed. */
  function reportFailure(e: unknown) {
    const detail = e instanceof Error && e.message ? e.message : null;
    setToast(detail ? `Generation failed — ${detail}` : "Generation failed — the backend returned an error. Please try again.");
  }

  /** Dispatch to the active composer mode; wired to ⌘↵ and the retry button. */
  function generate() {
    if (mode === "script") void generateScript();
    else void generateSolo();
  }

  async function generateScript() {
    if (busy || scriptLines.length === 0) return;
    setBusy(true);
    clearNotices();
    const lines: PerfLine[] = scriptLines.map((l) => ({ character_id: l.characterId, text: l.text.trim() }));
    const ctrl = newRun();
    try {
      const r = await perform(lines, expr, ctrl.signal, format);
      if (!mounted.current) return;
      seq.current += 1;
      const distinct = [...new Set(lines.map((l) => l.character_id))];
      const label = distinct.length === 1 ? charName(distinct[0]) : `Ensemble · ${distinct.length} voices`;
      const transcript = lines.map((l) => `${charName(l.character_id)}: ${stripTags(l.text)}`).join("  ·  ");
      // Stamp the CAST onto the segments. The engine reports who spoke each
      // segment as an id; the roster that turns an id into a name lives here
      // and nowhere else, and a share page has no roster to look one up in. A
      // published ensemble used to arrive on /t/{id} as a flat list of
      // segments naming nobody, under one label reading "Ensemble · N voices"
      // — the scene, gone at the exact moment it was shared.
      const cast: Segment[] = r.segments.map((s) => (
        s.characterId ? { ...s, characterName: charName(s.characterId) } : s
      ));
      const take: Take = {
        id: `take-${Date.now()}-${seq.current}`, text: transcript,
        characterId: lines[0].character_id, characterName: label,
        mode: r.mode, fallbackReason: r.fallbackReason, fallbackDetail: r.fallbackDetail,
        url: r.url, blob: r.blob, peaks: r.peaks, seconds: r.seconds, kb: r.kb, rtf: r.rtf,
        synthSeconds: r.synthSeconds, queueSeconds: r.queueSeconds,
        ignoredSettings: r.ignoredSettings, segments: cast, reportCorrupt: r.reportCorrupt,
        expr: { ...expr },
        createdAt: Date.now(), format: r.format, lines,
        timingVersion: TAKE_TIMING_VERSION,
      };
      addTake(take);
      setFallback(r.mode === "browser" ? { reason: r.fallbackReason ?? "unreachable", detail: r.fallbackDetail } : null);
    } catch (e) {
      if (!mounted.current) return;
      if (isAbort(e)) { /* user cancelled — no take, no error */ }
      else if (e instanceof EngineBusyError) setBusyNotice({ retryAfterSec: e.retryAfterSec });
      else reportFailure(e);
    } finally { if (mounted.current) setBusy(false); }
  }

  async function generateSolo() {
    if (!plain || busy || !character) return;
    setBusy(true);
    clearNotices();
    const ctrl = newRun();
    // Streamed first listen: an untagged wav take starts sounding at
    // first-SEGMENT time instead of whole-body time. `speakStreaming` falls
    // back to the buffered call for everything else — a tagged take (the
    // streaming route has no metatag grammar), an mp3, a script — so this one
    // call site covers both paths and no screen has to know which it got.
    const player = createStreamPlayer();
    streamRef.current = player;
    try {
      const r = await speakStreaming(
        text, character.character_id, expr,
        {
          player,
          onProgress: (seconds) => { if (mounted.current) setStreamedSec(seconds); },
        },
        ctrl.signal, format,
      );
      if (!mounted.current) return;
      seq.current += 1;
      // Timestamped id so restored takes (which keep their stored ids) never
      // collide with freshly generated ones.
      const take: Take = {
        id: `take-${Date.now()}-${seq.current}`, text: text.trim(),
        characterId: character.character_id, characterName: character.name,
        mode: r.mode, fallbackReason: r.fallbackReason, fallbackDetail: r.fallbackDetail,
        url: r.url, blob: r.blob, peaks: r.peaks, seconds: r.seconds, kb: r.kb, rtf: r.rtf,
        synthSeconds: r.synthSeconds, queueSeconds: r.queueSeconds,
        ignoredSettings: r.ignoredSettings, segments: r.segments, reportCorrupt: r.reportCorrupt,
        expr: { ...expr },
        createdAt: Date.now(), format: r.format,
        timingVersion: TAKE_TIMING_VERSION,
      };
      addTake(take);
      setFallback(r.mode === "browser" ? { reason: r.fallbackReason ?? "unreachable", detail: r.fallbackDetail } : null);
    } catch (e) {
      if (!mounted.current) return;
      // Backpressure keeps the engine reachable — offer a retry. Anything else
      // (a gone Character, an unexpected throw) is a genuine failure that must
      // be visible, in the backend's own words.
      if (isAbort(e)) {
        // The user pressed Cancel: not a failure, so no toast and no take.
      } else if (e instanceof EngineBusyError) {
        setBusyNotice({ retryAfterSec: e.retryAfterSec });
      } else {
        reportFailure(e);
      }
    } finally {
      // The run owns the player only while it is running: once the take is in
      // the log its tail may finish playing, but a LATER cancel must not reach
      // back and silence it.
      if (streamRef.current === player) streamRef.current = null;
      if (mounted.current) { setBusy(false); setStreamedSec(null); }
    }
  }

  return {
    busy, busyNotice, retryIn, startedAt, streamedSec,
    toast, setToast, fallbackNotice, generate, cancelGenerate,
  };
}
