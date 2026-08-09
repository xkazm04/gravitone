"use client";

// ── the channels ─────────────────────────────────────────────────────────────
// The single scoped node and the ONE requestAnimationFrame writer that feeds
// it. Everything here is a CSS custom-property write on `nodeRef` — no React
// state changes in the hot loop, which is the whole performance budget.
//
// prefers-reduced-motion is honoured HERE, at the bus, not in each reader: the
// channels stop oscillating and hold a static peak.

import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  STATIC_SAMPLE_MS,
  centroid,
  prefersReducedMotion,
  q,
  sample,
} from "./audioBusAnalysis";

export function useAudioBusChannels({
  live,
  analyserRef,
  timeBuf,
  freqBuf,
}: {
  live: boolean;
  analyserRef: RefObject<AnalyserNode | null>;
  timeBuf: RefObject<Uint8Array | null>;
  freqBuf: RefObject<Uint8Array | null>;
}) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const levelRef = useRef(0);
  const staticPeakRef = useRef(0);
  const lastStaticRef = useRef(0);
  const writtenRef = useRef<Record<string, string>>({});

  const write = useCallback((name: string, value: string) => {
    const node = nodeRef.current;
    if (!node) return;
    if (writtenRef.current[name] === value) return;
    writtenRef.current[name] = value;
    node.style.setProperty(name, value);
  }, []);

  const resetChannels = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    // Remove rather than zero, so the :root defaults (and any outer override)
    // take over again and the idle look is byte-identical to pre-bus.
    for (const name of ["--gt-level", "--gt-peak", "--gt-centroid"]) {
      node.style.removeProperty(name);
      delete writtenRef.current[name];
    }
    levelRef.current = 0;
    staticPeakRef.current = 0;
  }, []);

  const setWorking = useCallback(
    (on: boolean) => write("--gt-working", on ? "1" : "0"),
    [write],
  );
  const setHue = useCallback(
    (hue: number | null) => {
      const node = nodeRef.current;
      if (!node) return;
      if (hue == null || !Number.isFinite(hue)) {
        node.style.removeProperty("--gt-hue");
        delete writtenRef.current["--gt-hue"];
        return;
      }
      write("--gt-hue", String(Math.round(((hue % 360) + 360) % 360)));
    },
    [write],
  );

  // ── the single writer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!live) {
      resetChannels();
      return;
    }
    const analyser = analyserRef.current;
    const time = timeBuf.current;
    const freq = freqBuf.current;
    if (!analyser || !time || !freq) return;

    const reduced = prefersReducedMotion();
    let stopped = false;

    const frame = () => {
      if (stopped) return;
      if (reduced) {
        // Static peak: resampled slowly and only ever upward, so motion-
        // sensitive users get a level indication with no oscillation.
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (now - lastStaticRef.current >= STATIC_SAMPLE_MS) {
          lastStaticRef.current = now;
          const { peak } = sample(analyser, time);
          if (peak > staticPeakRef.current) staticPeakRef.current = peak;
          write("--gt-level", String(q(staticPeakRef.current)));
          write("--gt-peak", String(q(staticPeakRef.current)));
        }
      } else {
        const { rms, peak } = sample(analyser, time);
        // Attack fast, release slow — the honest shape of a level meter.
        levelRef.current = rms > levelRef.current
          ? rms
          : levelRef.current * 0.82 + rms * 0.18;
        write("--gt-level", String(q(levelRef.current)));
        write("--gt-peak", String(q(peak)));
        const c = centroid(analyser, freq);
        if (c != null) write("--gt-centroid", String(q(c)));
      }
      rafRef.current = requestAnimationFrame(frame);
    };

    const start = () => {
      if (rafRef.current != null || stopped) return;
      rafRef.current = requestAnimationFrame(frame);
    };
    const stopLoop = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // The `anim-paused` convention says: do not burn frames nobody can see.
    // At bus level that means the tab, since the writer is document-wide.
    const onVisibility = () => (document.hidden ? stopLoop() : start());

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
      if (!document.hidden) start();
    } else {
      start();
    }

    return () => {
      stopped = true;
      stopLoop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      resetChannels();
    };
  }, [live, resetChannels, write, analyserRef, timeBuf, freqBuf]);

  return { nodeRef, setWorking, setHue };
}
