"use client";

import { useEffect, useState } from "react";
import { useTransport } from "@/components/ui/useTransport";
import { useMounted } from "@/lib/useMounted";
import { assetRefusal } from "./failures";

/**
 * The review screen's ONE transport, and the one clip it is holding.
 *
 * Everything this flow plays — speaker samples, stem previews, audition takes —
 * goes through here, so two of them can never talk over each other.
 */
export function useClipTransport() {
  const mounted = useMounted();
  // The one clip this screen is playing, and the transport that plays it.
  // `playing` is DERIVED from the transport rather than set on click: a play()
  // the browser refuses must never leave a row saying "playing".
  const [clip, setClip] = useState<{ url: string; id: string } | null>(null);
  const transport = useTransport({ src: clip?.url });
  const playing = transport.playing ? clip?.id ?? null : null;
  // The service's own sentence about a clip that would not play.
  const [clipRefusal, setClipRefusal] = useState<string | null>(null);
  // A new clip starts when the element has it — one commit later, so the <audio>
  // is already holding the src. Deliberately not useTransport's `autoPlay`:
  // that starts with `asked: false` (an autoplay a browser refuses is policy,
  // not a broken take), and every one of these IS a click, so a refusal here is
  // a real failure and must be reported as one.
  useEffect(() => { if (clip) transport.play(); }, [clip]);   // eslint-disable-line react-hooks/exhaustive-deps
  // …and when it is, ask the service why. The element is told nothing about a
  // 404 body; the proxy still has the sentence.
  useEffect(() => {
    if (!transport.failed || !clip) return;
    void assetRefusal(clip.url).then((detail) => {
      if (detail && mounted.current) setClipRefusal(detail);
    });
  }, [transport.failed, clip, mounted]);

  /** Play one clip on the review screen's ONE transport.
   *
   *  It used to be a private `new Audio()` in a ref, which is exactly the debt
   *  <AuditionPanel> had a comment about: the Casting Board's segments play
   *  through the shared <TakePlayer>, this played through something the shared
   *  transport had never heard of, and the two were not mutually exclusive — a
   *  stem and a segment could talk over each other mid-review. Now everything
   *  on this screen is one transport, registered with the AudioBus (so the
   *  signal channels move with the stem the user is listening to) and exclusive
   *  with every other player in the app. */
  function playClip(url: string, id: string) {
    setClipRefusal(null);
    if (clip?.id === id && transport.playing) { transport.pause(); return; }
    // Same clip again: the element already holds it, so there is nothing to
    // load — replaying is the transport's own job.
    if (clip?.url === url) { transport.play(); return; }
    setClip({ url, id });
  }

  return {
    transport, playing, clipRefusal, playClip,
    clearRefusal: () => setClipRefusal(null),
  };
}
