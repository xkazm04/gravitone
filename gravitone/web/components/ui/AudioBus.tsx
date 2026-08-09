"use client";

// ── The Signal Layer ─────────────────────────────────────────────────────────
// One AudioContext, one AnalyserNode, one requestAnimationFrame writer, N free
// readers. The writer sets the contract-C4 channels
//
//   --gt-level     0..1  smoothed RMS   (how loud it is right now)
//   --gt-peak      0..1  short-term peak
//   --gt-centroid  0..1  spectral centroid (how bright the voice is)
//   --gt-hue       deg   active character / emotion hue
//   --gt-working   0|1   synthesis in flight (not audio — queue state)
//
// on a SINGLE scoped node, and every reader consumes them through
// transform/opacity/filter only. That is the whole performance budget: no React
// re-renders in the hot loop, no per-component analysers, no layout-triggering
// properties.
//
// Honesty rules baked in:
//  • createMediaElementSource() captures an element's output — a registered
//    <audio> that is not re-routed to the destination goes SILENT. Every
//    registered element is connected straight to ctx.destination as well as to
//    the analyser tap. AudioBus.test.tsx proves it, because the failure mode is
//    invisible in code review and catastrophic in the product.
//  • A microphone stream is tapped but NEVER routed to the destination (that is
//    acoustic feedback). The analyser drains into a zero-gain sink so the graph
//    still renders.
//  • AudioContext needs a user gesture. The bus resumes lazily on the first
//    pointer/key event and, if anything at all is unavailable or throws, it
//    degrades to keyframe mode (channels stay at their :root defaults, the CSS
//    keyframe decoration keeps running) and never throws at a caller.
//  • prefers-reduced-motion is honoured HERE, at the bus, not in each reader:
//    the channels stop oscillating and hold a static peak.
//
// The graph lives in ./useAudioBusGraph, the writer in ./useAudioBusChannels
// and the arithmetic in ./audioBusAnalysis; this file is the public surface
// those three are wired into.

import { createContext, useContext, useEffect, useMemo } from "react";
import { SIGNAL_DEFAULTS } from "./tokens";
import { useAudioBusChannels } from "./useAudioBusChannels";
import { useAudioBusGraph } from "./useAudioBusGraph";

/**
 * The command surface. Deliberately STABLE for the lifetime of the provider:
 * registrars hold it in effects and ref callbacks, and an identity change there
 * means "tear down and re-register", which for a media element means creating a
 * second source node for the same element. Liveness is a separate context
 * (`useSignalLive`) precisely so that reading it cannot churn registrations.
 */
export type AudioBusApi = {
  /** Tap a media element AND keep it audible. Safe to call repeatedly. */
  register: (el: HTMLMediaElement | null | undefined) => void;
  /** Drop the analyser tap (playback is left alone). For teardown. */
  unregister: (el: HTMLMediaElement | null | undefined) => void;
  /** Tap a mic/capture stream. Never routed to the speakers. */
  registerStream: (stream: MediaStream | null | undefined) => void;
  unregisterStream: (stream: MediaStream | null | undefined) => void;
  /** `--gt-working`: the model is busy (queue/stream state, not audio). */
  setWorking: (on: boolean) => void;
  /** `--gt-hue`: the active character's / emotion's hue in degrees. */
  setHue: (hue: number | null) => void;
};

const NOOP: AudioBusApi = {
  register: () => {},
  unregister: () => {},
  registerStream: () => {},
  unregisterStream: () => {},
  setWorking: () => {},
  setHue: () => {},
};

const BusContext = createContext<AudioBusApi>(NOOP);
const LiveContext = createContext(false);

/** Registrars. Outside a provider every method is a no-op, so any component may
 *  use the bus without knowing whether one is mounted. */
export function useAudioBus(): AudioBusApi {
  return useContext(BusContext);
}

/** true when real audio is driving the channels — for surfaces that want to say
 *  so ("live") rather than just react. Readers of the channels themselves need
 *  nothing: CSS keys off `[data-gt-live]`. */
export function useSignalLive(): boolean {
  return useContext(LiveContext);
}

// ── imperative escape hatch ──────────────────────────────────────────────────
// Plain modules (the playground's useAudioPlayer, which builds its own Audio()
// outside the render tree) cannot call a hook at the point the element is
// created. They get these module functions, which forward to the mounted bus
// and no-op when there isn't one.
let ACTIVE: AudioBusApi | null = null;
export function busRegister(el: HTMLMediaElement | null | undefined) {
  ACTIVE?.register(el);
}
export function busSetWorking(on: boolean) {
  ACTIVE?.setWorking(on);
}
export function busSetHue(hue: number | null) {
  ACTIVE?.setHue(hue);
}

export default function AudioBusProvider({ children }: { children: React.ReactNode }) {
  const {
    analyserRef, timeBuf, freqBuf, sourceCount, degraded,
    register, unregister, registerStream, unregisterStream,
  } = useAudioBusGraph();

  const live = sourceCount > 0 && !degraded;

  const { nodeRef, setWorking, setHue } = useAudioBusChannels({
    live, analyserRef, timeBuf, freqBuf,
  });

  const api = useMemo<AudioBusApi>(
    () => ({ register, unregister, registerStream, unregisterStream, setWorking, setHue }),
    [register, unregister, registerStream, unregisterStream, setWorking, setHue],
  );

  // Publish for the imperative hatch (module-scope callers).
  useEffect(() => {
    ACTIVE = api;
    return () => {
      if (ACTIVE === api) ACTIVE = null;
    };
  }, [api]);

  return (
    <BusContext.Provider value={api}>
      <LiveContext.Provider value={live}>
      {/*
        The scoped node. `display: contents` means it adds no box — zero layout
        impact — while still being the single element the writer touches and the
        inheritance root every reader resolves against. `data-gt-live` is what
        readers key off to swap keyframe decoration for real signal.
      */}
      <div
        ref={nodeRef}
        data-gt-bus=""
        data-gt-live={live ? "1" : undefined}
        style={{ display: "contents" }}
      >
        {children}
      </div>
      </LiveContext.Provider>
    </BusContext.Provider>
  );
}

/** Exported for tests + docs: the channels this bus owns (contract C4). */
export const SIGNAL_CHANNELS = Object.keys(SIGNAL_DEFAULTS);

/**
 * Declare the active character/emotion hue for as long as the component is
 * mounted, then hand the channel back. Surfaces that know "whose voice is this"
 * (a character page, the emotion picker) call this and the whole frame tints.
 */
export function useSignalHue(hue: number | null | undefined) {
  const { setHue } = useAudioBus();
  useEffect(() => {
    if (hue == null) return;
    setHue(hue);
    return () => setHue(null);
  }, [hue, setHue]);
}

/** Declare "the model is working" for as long as `on` is true. */
export function useSignalWorking(on: boolean) {
  const { setWorking } = useAudioBus();
  useEffect(() => {
    setWorking(on);
    return () => setWorking(false);
  }, [on, setWorking]);
}
