"use client";

// Hearing ONE region — the score's own small playback path.
//
// Split out of ScoreEditor because it is the only part of the score that owns
// anything with a LIFETIME: an <audio>, an in-flight request and an object URL,
// each of which leaks if the component goes away mid-preview. Keeping them in
// one hook keeps their cleanup in one place.

import { useEffect, useRef, useState } from "react";
import type { Expression, ScoreRegion } from "./shared";

type PreviewState = { index: number; url: string } | null;

export function useScorePreview({
  text,
  regions,
  characterId,
  expr,
  onNotice,
}: {
  /** PLAIN text — the same characters the regions' offsets are counted in. */
  text: string;
  regions: ScoreRegion[];
  /** Who previews a region. Absent → preview is offered but explained as off. */
  characterId?: string;
  expr: Expression;
  /** Where a refusal or a failure is said — the score's one live region. */
  onNotice: (message: string | null) => void;
}) {
  const [preview, setPreview] = useState<PreviewState>(null);
  const [busy, setBusy] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Object URLs and in-flight previews are ours to clean up: a score left open
  // while the console re-renders must not leak a WAV per click.
  useEffect(() => () => {
    abortRef.current?.abort();
    audioRef.current?.pause();
  }, []);
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

  // ── solo preview ───────────────────────────────────────────────────────────
  function stopPreview() {
    abortRef.current?.abort();
    abortRef.current = null;
    audioRef.current?.pause();
    setPreview(null); // the effect above revokes the object URL

    setBusy(false);
  }

  /**
   * Hear ONE region. Deliberately a small local request rather than the
   * console's engine: this asks for the span alone, with its own tag around it,
   * so what plays is what that direction sounds like — not the take it sits in.
   * A failure is reported as a sentence; nothing about the score changes.
   */
  async function playRegion(i: number) {
    const r = regions[i];
    if (!r) return;
    if (!characterId) {
      onNotice("Pick a Character above to hear a region on its own.");
      return;
    }
    stopPreview();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          character_id: characterId,
          text: `[${r.value}]${text.slice(r.start, r.end)}[/${r.value}]`,
          voice_settings: { temperature: expr.temperature, stability: expr.stability, quality: expr.quality },
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = ((await res.json()) as { detail?: string }).detail ?? "";
        } catch { /* a non-JSON error body tells us nothing extra */ }
        onNotice(`Could not preview that region${detail ? ` — ${detail}` : ` (the engine answered ${res.status})`}.`);
        setBusy(false);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      if (ac.signal.aborted) {
        URL.revokeObjectURL(url);
        return;
      }
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.src = url;
      audio.onended = () => setPreview(null);
      setPreview({ index: i, url });
      onNotice(null);
      try {
        await audio.play();
      } catch {
        onNotice("Your browser refused to start playback — press play again after interacting with the page.");
        setPreview(null);
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        onNotice("Could not reach the engine to preview that region.");
      }
    } finally {
      setBusy(false);
    }
  }

  return { preview, busy, stopPreview, playRegion };
}
