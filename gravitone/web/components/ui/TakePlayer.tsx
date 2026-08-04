"use client";

// The missing player primitive. Every surface that needed playback used to drop
// a raw <audio controls> — browser-chrome grey, alien to Obsidian, and unstyled
// per platform — or roll a private transport. <TakePlayer> is the one Obsidian
// transport: glass pill, cyan (or per-character hue) accent, a seek rail that is
// keyboard-operable, and — because it registers its element with the AudioBus —
// bars that move with the actual waveform instead of a CSS timer.

import { useCallback, useId } from "react";
import { useTransport } from "./useTransport";
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
  // The transport itself is the shared hook — this component is its chrome.
  const { playing, position, duration, failed, progress, toggle, seek, audioProps } =
    useTransport({ src, autoPlay, onEnded });
  const railId = useId();

  const tint = Number.isFinite(hue) ? (hue as number) : DEFAULT_HUE;

  const onRailKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowRight":
        case "ArrowUp":
          seek(position + SEEK_STEP);
          break;
        case "ArrowLeft":
        case "ArrowDown":
          seek(position - SEEK_STEP);
          break;
        case "Home":
          seek(0);
          break;
        case "End":
          seek(Number.MAX_SAFE_INTEGER); // clamped to the take's real duration
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
    [position, seek, toggle],
  );

  const onRailClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (!rect.width || !duration) return;
      seek(((e.clientX - rect.left) / rect.width) * duration);
    },
    [duration, seek],
  );

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
      <audio {...audioProps} />

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
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${clock(position)} of ${clock(duration)}`}
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
        {failed ? "unplayable" : `${clock(position)} / ${clock(duration)}`}
      </span>
    </div>
  );
}
