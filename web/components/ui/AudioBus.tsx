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

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SIGNAL_DEFAULTS } from "./tokens";

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

type Ctor = new () => AudioContext;
function audioContextCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
/** Quantise before writing: a var write is a style invalidation, and nobody can
 *  see the 4th decimal of a glow. */
const q = (n: number) => Math.round(clamp01(n) * 1000) / 1000;

/** RMS is small for speech (~0.05–0.2); lift it into a usable 0..1 display
 *  range rather than shipping a bus that looks broken on real voices. */
const LEVEL_GAIN = 3.2;
const PEAK_GAIN = 1.15;
/** Reduced motion: resample this slowly, so the value reads as static. */
const STATIC_SAMPLE_MS = 500;

export default function AudioBusProvider({ children }: { children: React.ReactNode }) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const elSources = useRef(new Map<HTMLMediaElement, MediaElementAudioSourceNode>());
  const streamSources = useRef(new Map<MediaStream, MediaStreamAudioSourceNode>());
  const rafRef = useRef<number | null>(null);
  const timeBuf = useRef<Uint8Array | null>(null);
  const freqBuf = useRef<Uint8Array | null>(null);
  const levelRef = useRef(0);
  const staticPeakRef = useRef(0);
  const lastStaticRef = useRef(0);
  const writtenRef = useRef<Record<string, string>>({});
  const degradedRef = useRef(false);

  const [sourceCount, setSourceCount] = useState(0);
  const [degraded, setDegraded] = useState(false);

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

  const live = sourceCount > 0 && !degraded;

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

    const sample = () => {
      // `as never`: lib.dom types getByteTimeDomainData as Uint8Array<ArrayBuffer>
      // in TS 5.7+, which our plain Uint8Array does not structurally satisfy.
      analyser.getByteTimeDomainData(time as never);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < time.length; i += 1) {
        const v = (time[i] - 128) / 128;
        sum += v * v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / time.length);
      return { rms: clamp01(rms * LEVEL_GAIN), peak: clamp01(peak * PEAK_GAIN) };
    };

    const centroid = () => {
      analyser.getByteFrequencyData(freq as never);
      let mag = 0;
      let weighted = 0;
      for (let i = 0; i < freq.length; i += 1) {
        mag += freq[i];
        weighted += freq[i] * i;
      }
      if (mag <= 0) return null;
      return clamp01(weighted / mag / freq.length);
    };

    const frame = () => {
      if (stopped) return;
      if (reduced) {
        // Static peak: resampled slowly and only ever upward, so motion-
        // sensitive users get a level indication with no oscillation.
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (now - lastStaticRef.current >= STATIC_SAMPLE_MS) {
          lastStaticRef.current = now;
          const { peak } = sample();
          if (peak > staticPeakRef.current) staticPeakRef.current = peak;
          write("--gt-level", String(q(staticPeakRef.current)));
          write("--gt-peak", String(q(staticPeakRef.current)));
        }
      } else {
        const { rms, peak } = sample();
        // Attack fast, release slow — the honest shape of a level meter.
        levelRef.current = rms > levelRef.current
          ? rms
          : levelRef.current * 0.82 + rms * 0.18;
        write("--gt-level", String(q(levelRef.current)));
        write("--gt-peak", String(q(peak)));
        const c = centroid();
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
  }, [live, resetChannels, write]);

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
