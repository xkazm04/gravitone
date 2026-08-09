"use client";

// THE TAKE LOG'S DATA LAYER — the list itself, its durability across a refresh,
// the object URLs it owns, and the sentence a screen reader hears when a render
// lands. Everything that DRAWS a take lives in PlaygroundTakeLog/TakeCard; this
// is only where takes come from and go.

import { useEffect, useRef, useState } from "react";
import type { useMounted } from "@/lib/useMounted";
import { putTake, getRecentTakes } from "@/lib/takeStore";
import { refinePeaks } from "./engine";
import type { Take } from "./shared";

export function usePlaygroundTakes(mounted: ReturnType<typeof useMounted>) {
  const [takes, setTakes] = useState<Take[]>([]);
  // A take that could not be written to IndexedDB (quota, private mode) is NOT
  // durable — saying nothing would leave the "survives a refresh" promise
  // silently broken.
  const [storageErr, setStorageErr] = useState<string | null>(null);
  // What to ANNOUNCE when a render finishes. Nothing announced one: the render
  // clock is deliberately aria-live="off" (it changes four times a second) and
  // the take log is not a live region, so a screen-reader user pressed Generate
  // and then sat in silence — the one thing the whole page exists to tell them
  // was the one thing it never said. Failures already speak: ErrorBanner is
  // role="alert".
  const [announcement, setAnnouncement] = useState("");

  // Restore the most recent session takes from IndexedDB on mount so a refresh
  // no longer destroys the log. Each restored take carries a fresh object URL.
  useEffect(() => {
    let cancelled = false;
    getRecentTakes(20)
      .then((restored) => {
        if (cancelled || restored.length === 0) {
          // Unmounted before restore landed — revoke the URLs we just minted.
          if (cancelled) for (const t of restored) if (t.url) URL.revokeObjectURL(t.url);
          return;
        }
        setTakes((current) => {
          const known = new Set(current.map((t) => t.id));
          return [...current, ...restored.filter((t) => !known.has(t.id))];
        });
      })
      .catch((e) => {
        // A restore that failed is not "no takes yet" — say the log could not
        // be read rather than rendering a false empty state.
        if (cancelled) return;
        const why = e instanceof Error ? e.message : "storage unavailable";
        setStorageErr(`Saved takes from your last session could not be restored (${why}).`);
      });
    return () => { cancelled = true; };
  }, []);

  // Revoke every take's object URL on unmount so navigating away doesn't leak
  // them (object URLs outlive component teardown in an SPA).
  const takesRef = useRef<Take[]>([]);
  useEffect(() => { takesRef.current = takes; }, [takes]);
  useEffect(() => () => {
    for (const t of takesRef.current) if (t.url) URL.revokeObjectURL(t.url);
  }, []);

  /** Persist a take (audio blob + metadata) so it survives a refresh.
   *  A failure here (quota exceeded, storage blocked) does not lose the take —
   *  but it DOES break the durability the log promises, so it is reported
   *  rather than swallowed. */
  async function persistTake(t: Take) {
    try {
      // The take already holds its blob (engine.ts carries it through); this
      // used to fetch the take's own object URL to get the same bytes back.
      await putTake(t, t.blob ?? null);
      if (mounted.current) setStorageErr(null);
    } catch (e) {
      if (!mounted.current) return;
      const why = e instanceof Error ? e.message : "storage unavailable";
      setStorageErr(`This take is in the log but could NOT be saved for after a refresh (${why}). Download the wav to keep it.`);
    }
  }

  /** Put a take in the log NOW, then refine its waveform.
   *
   *  Peak extraction decodes the whole WAV; doing it inside synthesis meant the
   *  take could not appear until a main-thread decode finished, for a
   *  decoration. The take is shown with its synthetic bars, the real ones swap
   *  in when the decode lands, and a decode that fails simply leaves the
   *  synthetic bars (the same degrade as before). Persistence waits for that
   *  settle so the stored take carries its final waveform. */
  function addTake(take: Take) {
    setTakes((t) => [take, ...t]);
    // The count makes each message distinct, so two identical takes in a row
    // are both announced (a live region ignores an unchanged string).
    const n = takesRef.current.length + 1;
    setAnnouncement(
      take.mode === "browser"
        ? `Browser-voice take ready — ${take.seconds} seconds from ${take.characterName}, Gravitone was not used. ${n} take${n === 1 ? "" : "s"} in the log.`
        : `Take ready — ${take.seconds} seconds of audio from ${take.characterName}. ${n} take${n === 1 ? "" : "s"} in the log.`,
    );
    if (!take.blob) { void persistTake(take); return; }
    void refinePeaks(take.blob).then((p) => {
      const finished: Take = p
        // X-Audio-Seconds is authoritative; the decoded duration only fills in
        // when the backend did not report one.
        ? { ...take, peaks: p.peaks, seconds: take.seconds || Math.round(p.duration * 10) / 10 }
        : take;
      if (mounted.current && p) {
        setTakes((list) => list.map((t) => (t.id === take.id ? { ...t, peaks: finished.peaks, seconds: finished.seconds } : t)));
      }
      void persistTake(finished);
    });
  }

  return { takes, setTakes, addTake, storageErr, setStorageErr, announcement, setAnnouncement };
}
