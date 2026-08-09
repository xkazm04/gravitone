"use client";

// The two aligned tracks, as one instrument: a ref per voice, a seek that moves
// both, and the deep link that opens the inspector AT a moment.

import { useCallback, useEffect, useRef } from "react";

export function useGymTrackSeek(initialSeekS?: number) {
  const userRef = useRef<HTMLAudioElement>(null);
  const agentRef = useRef<HTMLAudioElement>(null);

  /** Seek BOTH tracks to the same instant. Never autoplays. */
  const seekBoth = useCallback((atS: number) => {
    const t = Math.max(0, atS);
    for (const el of [userRef.current, agentRef.current]) {
      if (el) el.currentTime = t;
    }
  }, []);

  // A finding chip on the sessions table can open the inspector AT a moment:
  // seek once the tracks know their duration — without playing anything.
  useEffect(() => {
    if (initialSeekS === undefined) return;
    let done = false;
    const cleanups: (() => void)[] = [];
    const trySeek = () => {
      if (done) return;
      const els = [userRef.current, agentRef.current].filter((el): el is HTMLAudioElement => !!el);
      if (els.length && els.every((el) => el.readyState >= 1)) {
        done = true;
        seekBoth(initialSeekS);
      }
    };
    trySeek();
    for (const el of [userRef.current, agentRef.current]) {
      if (!el) continue;
      el.addEventListener("loadedmetadata", trySeek);
      cleanups.push(() => el.removeEventListener("loadedmetadata", trySeek));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [initialSeekS, seekBoth]);

  return { userRef, agentRef, seekBoth };
}
