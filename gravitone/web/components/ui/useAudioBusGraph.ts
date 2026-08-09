"use client";

// ── the graph ────────────────────────────────────────────────────────────────
// The ONE AudioContext and the ONE AnalyserNode, plus every registration path
// into them. Browsers cap live AudioContexts, so this hook is built to be used
// exactly once, by AudioBusProvider — everything else reaches it through the
// context API the provider publishes.
//
// The two silent failure modes live here, and so do their guards:
//  • createMediaElementSource() captures an element's output, so every
//    registered element is connected to ctx.destination FIRST and to the
//    analyser second;
//  • a mic stream reaches the analyser and NEVER the destination.

import { useCallback, useEffect, useRef, useState } from "react";
import { audioContextCtor } from "./audioBusAnalysis";

export function useAudioBusGraph() {
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const elSources = useRef(new Map<HTMLMediaElement, MediaElementAudioSourceNode>());
  const streamSources = useRef(new Map<MediaStream, MediaStreamAudioSourceNode>());
  const timeBuf = useRef<Uint8Array | null>(null);
  const freqBuf = useRef<Uint8Array | null>(null);
  const degradedRef = useRef(false);

  const [sourceCount, setSourceCount] = useState(0);
  const [degraded, setDegraded] = useState(false);

  /** Lazily build the graph. Returns null (and latches degraded) on any
   *  failure — a browser without Web Audio must still get the studio. */
  const ensure = useCallback((): AudioContext | null => {
    if (ctxRef.current) return ctxRef.current;
    if (degradedRef.current) return null;
    const Ctor = audioContextCtor();
    if (!Ctor) {
      degradedRef.current = true;
      setDegraded(true);
      return null;
    }
    try {
      const ctx = new Ctor();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;
      // Zero-gain sink: keeps the analyser inside a rendered path (a mic tap has
      // no other route to the destination) while emitting no sound.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      analyser.connect(sink);
      sink.connect(ctx.destination);
      ctxRef.current = ctx;
      analyserRef.current = analyser;
      sinkRef.current = sink;
      timeBuf.current = new Uint8Array(analyser.fftSize);
      freqBuf.current = new Uint8Array(analyser.frequencyBinCount);
      return ctx;
    } catch {
      degradedRef.current = true;
      setDegraded(true);
      return null;
    }
  }, []);

  const resume = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || ctx.state !== "suspended") return;
    try {
      void ctx.resume()?.catch?.(() => {});
    } catch {
      /* autoplay policy — the graph still renders once a gesture lands */
    }
  }, []);

  const register = useCallback(
    (el: HTMLMediaElement | null | undefined) => {
      if (!el) return;
      const ctx = ensure();
      if (!ctx || !analyserRef.current) return;
      if (elSources.current.has(el)) {
        resume();
        return;
      }
      try {
        const src = ctx.createMediaElementSource(el);
        // Destination FIRST: if the analyser tap somehow fails, the take is
        // still audible. Silence is the one regression this feature cannot ship.
        src.connect(ctx.destination);
        try {
          src.connect(analyserRef.current);
        } catch {
          /* tap unavailable — playback keeps working, channels stay idle */
        }
        elSources.current.set(el, src);
        setSourceCount(elSources.current.size + streamSources.current.size);
        resume();
      } catch {
        // Already owned by another context, or a cross-origin element: leave
        // the element completely alone rather than risk muting it.
      }
    },
    [ensure, resume],
  );

  const unregister = useCallback((el: HTMLMediaElement | null | undefined) => {
    if (!el) return;
    const src = elSources.current.get(el);
    if (!src) return;
    elSources.current.delete(el);
    // Only the tap is dropped. The element→destination edge stays, because
    // createMediaElementSource cannot be undone: cutting it would permanently
    // mute an element that is still on screen.
    try {
      if (analyserRef.current) src.disconnect(analyserRef.current);
    } catch {
      /* ignore */
    }
    setSourceCount(elSources.current.size + streamSources.current.size);
  }, []);

  const registerStream = useCallback(
    (stream: MediaStream | null | undefined) => {
      if (!stream) return;
      const ctx = ensure();
      if (!ctx || !analyserRef.current) return;
      if (streamSources.current.has(stream)) {
        resume();
        return;
      }
      try {
        const src = ctx.createMediaStreamSource(stream);
        // Analyser ONLY. Connecting a live mic to ctx.destination is feedback.
        src.connect(analyserRef.current);
        streamSources.current.set(stream, src);
        setSourceCount(elSources.current.size + streamSources.current.size);
        resume();
      } catch {
        /* no capture support — keyframe decoration stays */
      }
    },
    [ensure, resume],
  );

  const unregisterStream = useCallback((stream: MediaStream | null | undefined) => {
    if (!stream) return;
    const src = streamSources.current.get(stream);
    if (!src) return;
    streamSources.current.delete(stream);
    try {
      src.disconnect();
    } catch {
      /* ignore */
    }
    setSourceCount(elSources.current.size + streamSources.current.size);
  }, []);

  // ── lazy resume on the first user gesture ──────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onGesture = () => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      resume();
      if (ctx.state === "running") detach();
    };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "touchstart"];
    const detach = () => events.forEach((e) => window.removeEventListener(e, onGesture));
    events.forEach((e) => window.addEventListener(e, onGesture, { passive: true }));
    return detach;
  }, [resume]);

  // ── teardown ───────────────────────────────────────────────────────────────
  useEffect(
    () => () => {
      for (const src of streamSources.current.values()) {
        try {
          src.disconnect();
        } catch {
          /* ignore */
        }
      }
      streamSources.current.clear();
      elSources.current.clear();
      try {
        void ctxRef.current?.close()?.catch?.(() => {});
      } catch {
        /* ignore */
      }
      ctxRef.current = null;
      analyserRef.current = null;
      sinkRef.current = null;
    },
    [],
  );

  return {
    analyserRef,
    timeBuf,
    freqBuf,
    sourceCount,
    degraded,
    register,
    unregister,
    registerStream,
    unregisterStream,
  };
}
