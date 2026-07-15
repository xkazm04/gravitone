"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { stripTags, type Take } from "./shared";

/**
 * Unified transport for takes.
 *  - gravitone takes play a real WAV through an <audio> element (true seek/progress).
 *  - browser-fallback takes speak via SpeechSynthesis (progress is time-estimated).
 * Exposes play / pause / resume / stop and a 0..1 progress for the waveform.
 */
export function useAudioPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const elapsedRef = useRef(0);
  const lastTickRef = useRef(0);
  const currentRef = useRef<Take | null>(null);

  const [playingId, setPlayingId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);

  const getAudio = () => {
    if (!audioRef.current) {
      const a = new Audio();
      a.addEventListener("timeupdate", () => {
        if (a.duration) setProgress(a.currentTime / a.duration);
      });
      a.addEventListener("ended", () => {
        setPlayingId(null);
        setPaused(false);
        setProgress(0);
      });
      audioRef.current = a;
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
  }, []);

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
        try { await a.play(); } catch { /* autoplay blocked */ }
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
    [stop]
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

  return { playingId, paused, progress, toggle, stop };
}
