"use client";

// One published take's audio, as ONE transport.
//
// The share page draws a take twice — the card (glyph, waveform, glow) and the
// score (the shape of the performance) — and until now the card owned a private
// `new Audio(url)` that nothing else could reach. That is why the score was
// read-only: not a decision, an inherited fact about where the element lived.
// The fetch, the object URL, the peaks and the transport now live here, above
// both surfaces, so a click on the score moves the audio the card is playing.
//
// It degrades the way the card always did: a take whose audio cannot be read
// still renders, and SAYS the player is dead rather than offering a play button
// that does nothing forever.

import { useEffect, useState } from "react";
import { useTransport, type Transport } from "@/components/ui/useTransport";
import { computePeaks } from "@/app/playground/_variants/engine";

export type TakeTransport = Transport & {
  /** Real peaks from the decoded take. Empty until it decodes — and it may
   *  never: the waveform is decoration, the audio is not. */
  peaks: number[];
  /** Why there is nothing to play, in the studio's own words. */
  error: string | null;
};

/**
 * Fetch, decode and drive one published take.
 *
 * `takeId` of null builds an inert transport — the shape a component uses when
 * a PARENT owns the audio and handed it one (the share page), so the hook is
 * still called unconditionally on every render.
 */
export function useTakeTransport(takeId: string | null, bars: number): TakeTransport {
  const [url, setUrl] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!takeId) return;
    let alive = true;
    let minted: string | null = null;
    setError(null);
    (async () => {
      try {
        const r = await fetch(`/api/takes/${takeId}/audio`);
        if (!r.ok) {
          if (alive) setError("audio unavailable — shares are evicted oldest-first");
          return;
        }
        const blob = await r.blob();
        minted = URL.createObjectURL(blob);
        // If we unmounted while the fetch was in flight, the cleanup already
        // ran (when minted was still null), so revoke the URL we just made here
        // — otherwise this decoded-wav blob leaks until the tab closes.
        if (!alive) {
          URL.revokeObjectURL(minted);
          return;
        }
        setUrl(minted);
        try {
          const { peaks: p } = await computePeaks(blob, bars);
          if (alive) setPeaks(p);
        } catch {
          /* waveform is decoration */
        }
      } catch {
        // The card still renders — but say the player is dead instead of
        // hiding it behind a control that silently does nothing.
        if (alive) setError("audio unavailable — couldn't reach the studio");
      }
    })();
    return () => {
      alive = false;
      if (minted) URL.revokeObjectURL(minted);
    };
  }, [takeId, bars]);

  const transport = useTransport({ src: url });

  return {
    ...transport,
    peaks,
    // A source the element itself refused is the same class of answer as a
    // fetch that failed: there is no audio here, and the surface must say so.
    error: error ?? (transport.failed ? "this take could not be played" : null),
  };
}
