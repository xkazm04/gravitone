"use client";

// The transport, without the chrome.
//
// <TakePlayer> was declared "the one Obsidian transport", but it was one
// COMPONENT: every surface that wanted playback with a different shape around
// it built a private <audio> instead — TakeCard's `new Audio(url)`, the
// console's useAudioPlayer, the score editor's audioRef, the narration dock's.
// The product cost shows up on the share page: TakeScore could not offer
// seeking, because the take's audio lived inside a sibling component with no
// seam to reach it.
//
// So the state machine lives here, in a hook, and the chrome stays in the
// component. A caller that wants the pill renders <TakePlayer>; a caller that
// wants to draw its OWN surface over the same audio (a card and a score sharing
// one clip) calls this and spreads `audioProps` onto exactly one <audio>.
//
// Honesty rules it carries, unchanged from the component it came out of:
//   * a play() that is REFUSED never reports playing — and when the user asked
//     for it, that refusal is a failure the surface may name;
//   * an <audio> error names the source as unplayable rather than freezing the
//     transport mid-play;
//   * a new src resets position/duration instead of leaving numbers on screen
//     describing audio that is gone;
//   * and one it now ADDS, because a hook is the only place it can live: a clip
//     that starts pauses whatever was playing (see below).

import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioBus } from "./AudioBus";

// ── one clip at a time ───────────────────────────────────────────────────────
// Two takes playing over each other is never what anybody asked for, and it is
// what every surface with more than one player did: the ingest studio's private
// `new Audio()` and the Casting Board's <TakePlayer>s were separate transports
// that had no way to know about each other, so a stem and a segment could talk
// over one another mid-review.
//
// The rule lives HERE rather than in a provider because it is a property of
// playback itself, not of a subtree: every surface that adopts this hook gets
// it, including ones mounted outside any bus. It is driven by the `play` EVENT,
// not by the play() call, so it can never pause a clip on behalf of one that
// then failed to start.
let CURRENT: HTMLMediaElement | null = null;

function claimPlayback(el: HTMLMediaElement) {
  if (CURRENT && CURRENT !== el) {
    try { CURRENT.pause(); } catch { /* already gone from the document */ }
  }
  CURRENT = el;
}

function releasePlayback(el: HTMLMediaElement | null) {
  if (CURRENT === el) CURRENT = null;
}

export type TransportAudioProps = {
  ref: (el: HTMLAudioElement | null) => void;
  src: string | undefined;
  preload: "metadata";
  onPlay: () => void;
  onPause: () => void;
  onTimeUpdate: React.ReactEventHandler<HTMLAudioElement>;
  onLoadedMetadata: React.ReactEventHandler<HTMLAudioElement>;
  onEnded: () => void;
  onError: () => void;
};

export type Transport = {
  playing: boolean;
  /** Seconds into the take. */
  position: number;
  /** Seconds the element reports, 0 until its metadata loads. */
  duration: number;
  /** position/duration, 0 when there is no duration to divide by. */
  progress: number;
  /** The source could not be played — a dead URL, or a refused user gesture. */
  failed: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Move to an absolute offset, clamped to the take. */
  seek: (seconds: number) => void;
  /** Move to a fraction of the take — what a rail hands back. */
  seekFraction: (fraction: number) => void;
  /** Spread onto the ONE <audio> element this transport drives. */
  audioProps: TransportAudioProps;
};

export function useTransport({
  src,
  autoPlay = false,
  onEnded,
}: {
  src?: string | null;
  autoPlay?: boolean;
  onEnded?: () => void;
} = {}): Transport {
  const bus = useAudioBus();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);

  // Register once the element exists. The bus routes it back to the speakers —
  // createMediaElementSource would otherwise mute it (see AudioBus).
  const attach = useCallback(
    (el: HTMLAudioElement | null) => {
      audioRef.current = el;
      if (el) bus.register(el);
    },
    [bus],
  );
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      bus.unregister(el);
      // An element that leaves the document must not stay the one everything
      // else pauses for.
      releasePlayback(el);
    };
  }, [bus]);

  // A new src is a new take: reset rather than leaving the old duration and
  // position on screen describing audio that is gone.
  useEffect(() => {
    setPosition(0);
    setDuration(0);
    setFailed(false);
    setPlaying(false);
  }, [src]);

  /** `asked` = a user pressed play. An autoplay a browser refuses is policy,
   *  not a broken take, and must never be reported as one. */
  const start = useCallback((asked: boolean) => {
    const el = audioRef.current;
    if (!el) return;
    void Promise.resolve(el.play?.()).catch(() => {
      setPlaying(false);
      if (asked) setFailed(true);
    });
  }, []);

  const play = useCallback(() => start(true), [start]);
  const pause = useCallback(() => audioRef.current?.pause(), []);

  useEffect(() => {
    if (!autoPlay) return;
    start(false);
  }, [autoPlay, src, start]);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) start(true);
    else el.pause();
  }, [start]);

  const seek = useCallback(
    (seconds: number) => {
      const el = audioRef.current;
      if (!el) return;
      const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;
      const next = Math.max(0, Math.min(max || 0, seconds));
      el.currentTime = next;
      setPosition(next);
    },
    [duration],
  );

  const seekFraction = useCallback(
    (fraction: number) => {
      const el = audioRef.current;
      const max = el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;
      if (!(max > 0)) return;
      seek(Math.max(0, Math.min(1, fraction)) * max);
    },
    [duration, seek],
  );

  return {
    playing,
    position,
    duration,
    progress: duration > 0 ? Math.min(1, position / duration) : 0,
    failed,
    play,
    pause,
    toggle,
    seek,
    seekFraction,
    audioProps: {
      ref: attach,
      src: src ?? undefined,
      preload: "metadata",
      onPlay: () => {
        if (audioRef.current) claimPlayback(audioRef.current);
        setPlaying(true);
      },
      onPause: () => {
        releasePlayback(audioRef.current);
        setPlaying(false);
      },
      onTimeUpdate: (e) => setPosition(e.currentTarget.currentTime),
      onLoadedMetadata: (e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d)) setDuration(d);
      },
      onEnded: () => {
        releasePlayback(audioRef.current);
        setPlaying(false);
        setPosition(0);
        onEnded?.();
      },
      onError: () => {
        // A dead object URL used to leave the transport frozen mid-play.
        releasePlayback(audioRef.current);
        setFailed(true);
        setPlaying(false);
      },
    },
  };
}
