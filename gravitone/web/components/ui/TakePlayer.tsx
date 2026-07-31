"use client";

// The missing player primitive. Every surface that needed playback used to drop
// a raw <audio controls> — browser-chrome grey, alien to Obsidian, and unstyled
// per platform — or roll a private transport. <TakePlayer> is the one Obsidian
// transport: glass pill, cyan (or per-character hue) accent, a seek rail that is
// keyboard-operable, and — because it registers its element with the AudioBus —
// bars that move with the actual waveform instead of a CSS timer.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAudioBus } from "./AudioBus";
import { Waveform } from "./Primitives";

const DEFAULT_HUE = 190; // the cyan accent, in hue terms
const SEEK_STEP = 5; // seconds per arrow press

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  return `${Math.floor(seconds / 60)}:${s < 10 ? "0" : ""}${s}`;
}

export default function TakePlayer({
  src,
  hue,
  compact = false,
  onEnded,
  label = "take",
  autoPlay = false,
  className = "",
}: {
  src: string;
  /** Character / emotion hue in degrees — tints the transport and the frame. */
  hue?: number;
  /** Dense inline variant (rows, lists) instead of the full-width transport. */
  compact?: boolean;
  onEnded?: () => void;
  /** Spoken name of this audio, used for the group + button labels. */
  label?: string;
  autoPlay?: boolean;
  className?: string;
}) {
  const bus = useAudioBus();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  const railId = useId();

  const tint = Number.isFinite(hue) ? (hue as number) : DEFAULT_HUE;

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
    return () => bus.unregister(el);
  }, [bus]);

  // A new src is a new take: reset the transport rather than leaving the old
  // duration/progress on screen describing audio that is gone.
  useEffect(() => {
    setCurrent(0);
    setDuration(0);
    setFailed(false);
    setPlaying(false);
  }, [src]);

  useEffect(() => {
    if (!autoPlay) return;
    const el = audioRef.current;
    if (!el) return;
    // Autoplay may be refused; that is not an error state, the user just presses
    // play. Never report a play we did not get.
    void Promise.resolve(el.play?.()).catch(() => setPlaying(false));
  }, [autoPlay, src]);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void Promise.resolve(el.play?.()).catch(() => setPlaying(false));
    else el.pause();
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const el = audioRef.current;
    if (!el) return;
    const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;
    const next = Math.max(0, Math.min(max || 0, seconds));
    el.currentTime = next;
    setCurrent(next);
  }, [duration]);

  const onRailKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const el = audioRef.current;
      if (!el) return;
      const max = Number.isFinite(el.duration) ? el.duration : duration;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowUp":
          seekTo(current + SEEK_STEP);
          break;
        case "ArrowLeft":
        case "ArrowDown":
          seekTo(current - SEEK_STEP);
          break;
        case "Home":
          seekTo(0);
          break;
        case "End":
          seekTo(max);
          break;
        case " ":
        case "Enter":
          toggle();
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    [current, duration, seekTo, toggle],
  );

  const onRailClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (!rect.width || !duration) return;
      seekTo(((e.clientX - rect.left) / rect.width) * duration);
    },
    [duration, seekTo],
  );

  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const accent = `hsl(${tint} 85% 62%)`;

  return (
    <div
      role="group"
      aria-label={label}
      className={`flex items-center gap-3 rounded-full border border-white/10 bg-black/30 backdrop-blur-[var(--gt-blur)] ${
        compact ? "px-2 py-1.5" : "px-3 py-2.5"
      } ${className}`}
      style={{ boxShadow: `inset 0 0 0 1px hsl(${tint} 85% 62% / 0.08)` }}
    >
      {/* The element itself is never shown — no browser chrome anywhere. */}
      <audio
        ref={attach}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          onEnded?.();
        }}
        onError={() => {
          // A dead object URL used to leave the transport frozen mid-play.
          setFailed(true);
          setPlaying(false);
        }}
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        aria-pressed={playing}
        className={`grid shrink-0 cursor-pointer place-items-center rounded-full text-slate-950 transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 ${
          compact ? "h-7 w-7 text-[11px]" : "h-9 w-9 text-[13px]"
        }`}
        style={{ background: accent, outlineColor: accent }}
      >
        {playing ? "❙❙" : "▶"}
      </button>

      {!compact && (
        <div className="pointer-events-none h-6 w-16 shrink-0 overflow-hidden">
          <Waveform bars={12} className="h-6 w-16" />
        </div>
      )}

      <div
        id={railId}
        role="slider"
        tabIndex={0}
        aria-label={`Seek ${label}`}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        aria-valuetext={`${clock(current)} of ${clock(duration)}`}
        onKeyDown={onRailKeyDown}
        onClick={onRailClick}
        className="group relative h-2 min-w-16 flex-1 cursor-pointer rounded-full bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4"
        style={{ outlineColor: accent }}
      >
        {/* transform-only fill: no layout on every timeupdate */}
        <span
          className="absolute inset-0 origin-left rounded-full"
          style={{
            background: `linear-gradient(90deg, hsl(${tint} 85% 62% / 0.55), ${accent})`,
            transform: `scaleX(${progress})`,
          }}
        />
      </div>

      <span className="font-jetbrains shrink-0 text-[11px] tabular-nums text-white/55">
        {failed ? "unplayable" : `${clock(current)} / ${clock(duration)}`}
      </span>
    </div>
  );
}
