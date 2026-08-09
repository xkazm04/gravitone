"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { busRegister } from "@/components/ui/AudioBus";
import { stripTags, type Take } from "./playgroundHelpers";

/**
 * Playback position, as something you SUBSCRIBE to rather than something the
 * owner re-renders for.
 *
 * `timeupdate` fires ~4×/s, and progress lived in the console's own state — so
 * every tick re-rendered a 1,700-line component whose take log is a list of
 * AnimatePresence `layout` children, each of which re-measures on every render.
 * Four times a second, for the whole time a take is playing. RenderStatus
 * already fixed this for the render clock; the playhead was left behind.
 *
 * The value lives in a ref and the readers subscribe, so a tick re-renders the
 * bars and the punch-in rail and NOTHING else. Same numbers, same UI.
 */
export type ProgressSource = {
  get: () => number;
  subscribe: (onChange: () => void) => () => void;
};

const NEVER: ProgressSource["subscribe"] = () => () => {};
const ZERO = () => 0;

/**
 * Read a progress source. `null` — the row that is not the playing one — reads
 * a constant 0 and subscribes to nothing.
 */
export function usePlaybackProgress(source: ProgressSource | null): number {
  return useSyncExternalStore(
    source ? source.subscribe : NEVER,
    source ? source.get : ZERO,
    ZERO, // the server has no playhead
  );
}

/**
 * Unified transport for takes.
 *  - gravitone takes play a real WAV through an <audio> element (true seek/progress).
 *  - browser-fallback takes speak via SpeechSynthesis (progress is time-estimated).
 * Exposes play / pause / resume / stop and a subscribable 0..1 progress.
 */
export function useAudioPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const elapsedRef = useRef(0);
  const lastTickRef = useRef(0);
  const currentRef = useRef<Take | null>(null);
  // A seek requested before the element knows its duration. Setting currentTime
  // on an <audio> whose metadata has not loaded is silently dropped, which is
  // how "click a segment to hear it" became "play from the start".
  const pendingSeekRef = useRef<number | null>(null);

  const [playingId, setPlayingId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  // The playhead: a ref plus its watchers, never state. Nothing that holds this
  // hook re-renders because a take moved 250ms forward.
  const progressRef = useRef(0);
  const watchers = useRef(new Set<() => void>()).current;
  const setProgress = useCallback((at: number) => {
    if (progressRef.current === at) return;
    progressRef.current = at;
    for (const w of watchers) w();
  }, [watchers]);
  const progress = useRef<ProgressSource>({
    get: () => progressRef.current,
    subscribe: (onChange) => {
      watchers.add(onChange);
      return () => { watchers.delete(onChange); };
    },
  }).current;

  const getAudio = () => {
    if (!audioRef.current) {
      const a = new Audio();
      a.addEventListener("timeupdate", () => {
        if (a.duration) setProgress(a.currentTime / a.duration);
      });
      a.addEventListener("loadedmetadata", () => {
        const at = pendingSeekRef.current;
        pendingSeekRef.current = null;
        if (at === null) return;
        try {
          a.currentTime = at;
        } catch {
          /* an unseekable source plays from the start — nothing is lost */
        }
      });
      a.addEventListener("ended", () => {
        setPlayingId(null);
        setPaused(false);
        setProgress(0);
      });
      a.addEventListener("error", () => {
        // A dead/expired object URL fired no event at all before, leaving the
        // row stuck on the pause glyph at 0 progress indefinitely.
        setPlayingId(null);
        setPaused(false);
        setProgress(0);
      });
      audioRef.current = a;
      // Signal Layer: hand this element to the AudioBus so the playground's
      // waveform/equalizer show the take that is actually playing. The bus
      // re-routes it to the speakers (createMediaElementSource captures the
      // output) and no-ops when no bus is mounted.
      busRegister(a);
    }
    return audioRef.current;
  };

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const runTimer = (take: Take) => {
    clearTimer();
    lastTickRef.current = performance.now();
    timerRef.current = window.setInterval(() => {
      const now = performance.now();
      elapsedRef.current += now - lastTickRef.current;
      lastTickRef.current = now;
      setProgress(Math.min(1, elapsedRef.current / (take.seconds * 1000)));
    }, 80);
  };

  const stop = useCallback(() => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    clearTimer();
    elapsedRef.current = 0;
    currentRef.current = null;
    setPlayingId(null);
    setPaused(false);
    setProgress(0);
  }, [setProgress]);

  const play = useCallback(
    async (take: Take) => {
      stop();
      currentRef.current = take;
      setPlayingId(take.id);
      setPaused(false);
      setProgress(0);

      if (take.mode === "gravitone" && take.url) {
        const a = getAudio();
        a.src = take.url;
        try {
          await a.play();
        } catch {
          // autoplay blocked / source unplayable — reset instead of leaving
          // the row frozen in a fake "playing" state
          setPlayingId(null);
          setProgress(0);
        }
      } else {
        const synth = window.speechSynthesis;
        const u = new SpeechSynthesisUtterance(stripTags(take.text));
        u.onend = () => {
          // speechSynthesis.cancel() (fired by stop() when switching takes)
          // asynchronously delivers THIS utterance's onend after play(next) has
          // already set the new current take. Ignore it unless we're still the
          // current take, or it would null out the newly-playing take's state.
          if (currentRef.current !== take) return;
          clearTimer();
          elapsedRef.current = 0;
          setPlayingId(null);
          setPaused(false);
          setProgress(0);
        };
        synth.speak(u);
        elapsedRef.current = 0;
        runTimer(take);
      }
    },
    [stop, setProgress]
  );

  const pause = useCallback(() => {
    const take = currentRef.current;
    if (!take) return;
    if (take.mode === "gravitone") audioRef.current?.pause();
    else window.speechSynthesis?.pause();
    clearTimer();
    setPaused(true);
  }, []);

  const resume = useCallback(async () => {
    const take = currentRef.current;
    if (!take) return;
    if (take.mode === "gravitone") {
      try { await audioRef.current?.play(); } catch { /* ignore */ }
    } else {
      window.speechSynthesis?.resume();
      runTimer(take);
    }
    setPaused(false);
  }, []);

  /**
   * Play a take FROM a given offset — the seam the segment timeline clicks
   * through.
   *
   * Browser-fallback takes have no audio to seek (SpeechSynthesis has no
   * transport at all), so this returns false for them rather than pretending:
   * the caller keeps the region selectable for editing and simply does not move
   * a playhead that does not exist.
   */
  const seekTo = useCallback(
    async (take: Take, seconds: number): Promise<boolean> => {
      if (take.mode !== "gravitone" || !take.url) return false;
      const a = getAudio();
      const at = Math.max(0, seconds);
      const switching = currentRef.current?.id !== take.id;
      if (switching) {
        stop();
        currentRef.current = take;
        pendingSeekRef.current = at;
        a.src = take.url;
      } else {
        try { a.currentTime = at; } catch { pendingSeekRef.current = at; }
      }
      setPlayingId(take.id);
      setPaused(false);
      setProgress(take.seconds > 0 ? Math.min(1, at / take.seconds) : 0);
      try {
        await a.play();
      } catch {
        // autoplay refused / source unplayable — never leave a fake playing row
        setPlayingId(null);
        setProgress(0);
        return false;
      }
      return true;
    },
    [stop, setProgress],
  );

  /** One control for the row button: play → pause → resume. */
  const toggle = useCallback(
    (take: Take) => {
      if (playingId === take.id) {
        if (paused) void resume();
        else pause();
      } else {
        void play(take);
      }
    },
    [playingId, paused, play, pause, resume]
  );

  useEffect(() => () => stop(), [stop]);

  return { playingId, paused, progress, toggle, stop, seekTo };
}
