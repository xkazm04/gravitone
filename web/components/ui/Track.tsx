"use client";

// The rail — the design system's first primitive for TIME and SPAN.
//
// Everything the studio makes is timed and structured (a take is a sequence of
// segments; a script is a sequence of lines) and until now the primitive layer
// modelled none of it: a take was one opaque <audio> blob and the only "audio"
// visuals in the system were bars on a CSS timer. <Track> is the surface those
// things get drawn ON — a fixed-height glass rail carrying
//
//   * peak bars, from a take's real decoded peaks when it has them and from the
//     shared <EqBars> field when it does not (same machinery as <Waveform> and
//     <Equalizer>, so an undecoded take still reads as audio rather than as an
//     empty box),
//   * a <Playhead> bound to a 0..1 `progress` scalar — exactly what
//     useAudioPlayer already returns,
//   * click-to-seek, as a real ARIA slider so the rail is operable from the
//     keyboard and not only from a mouse,
//   * an overlay for whatever the caller wants placed ON the rail (regions).
//
// It is PURELY presentational: it owns no audio, no player and no data. It is
// handed numbers and hands back a fraction.

import type { CSSProperties, ReactNode } from "react";
import { useRef } from "react";
import { EqBars } from "./Equalizer";

/** How far one arrow press moves the playhead (fraction of the whole rail). */
const STEP = 0.02;
/** …and one Page press. */
const PAGE = 0.1;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** m:ss for a duration in seconds. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  return `${Math.floor(seconds / 60)}:${s < 10 ? "0" : ""}${s}`;
}

/**
 * The position line. Drawn only when the caller says there is a position to
 * draw — a line parked at 0 on every idle rail reads as a claim about where
 * playback is, which is the same lie the CSS-timer equalizer used to tell.
 */
export function Playhead({ progress, hue = 190 }: { progress: number; hue?: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 z-20 w-px transition-[left] duration-75 ease-linear"
      style={{
        left: `${clamp01(progress) * 100}%`,
        background: `hsl(${hue} 90% 78%)`,
        boxShadow: `0 0 6px hsl(${hue} 90% 70% / 0.8)`,
      }}
    />
  );
}

export default function Track({
  peaks,
  progress,
  playing = false,
  onSeek,
  label,
  hue = 190,
  height = 44,
  bars = 48,
  children,
  className = "",
  valueText,
}: {
  /** A take's real peaks (0..1 per bar). Absent → the shared idle bar field. */
  peaks?: number[];
  /** 0..1 playhead position. Absent → no playhead is drawn. */
  progress?: number;
  /** Whether the playhead means anything right now. */
  playing?: boolean;
  /** Seek to a fraction of the rail. Absent → the rail is not interactive. */
  onSeek?: (fraction: number) => void;
  /** What this rail IS, for screen readers. Required — a nameless rail is a
   *  decoration, and this one is a control. */
  label: string;
  /** Tint, normally an emotion's or a Character's hue. */
  hue?: number;
  height?: number;
  /** Idle bar count when there are no peaks. 0 = draw no texture at all, for a
   *  rail whose content is its overlay (a score lane, not a waveform). */
  bars?: number;
  /** Anything drawn ON the rail (regions). Pointer events are off by default so
   *  the rail stays seekable; a child that wants clicks re-enables its own. */
  children?: ReactNode;
  className?: string;
  /** Spoken form of the current position, e.g. "0:12 of 0:40". */
  valueText?: (fraction: number) => string;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const at = clamp01(progress ?? 0);
  const seekable = !!onSeek;

  /** Where in the rail (0..1) a client x coordinate falls. */
  const fractionAt = (clientX: number): number => {
    const box = railRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    return clamp01((clientX - box.left) / box.width);
  };

  const seekBy = (delta: number) => onSeek?.(clamp01(at + delta));

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onSeek) return;
    const move =
      e.key === "ArrowRight" || e.key === "ArrowUp" ? STEP
      : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -STEP
      : e.key === "PageUp" ? PAGE
      : e.key === "PageDown" ? -PAGE
      : 0;
    if (move !== 0) {
      e.preventDefault();
      seekBy(move);
      return;
    }
    if (e.key === "Home") { e.preventDefault(); onSeek(0); }
    else if (e.key === "End") { e.preventDefault(); onSeek(1); }
  }

  return (
    <div
      ref={railRef}
      className={`relative overflow-hidden rounded-xl border border-white/10 bg-black/30 ${className}`}
      style={{ height }}
    >
      {/* the bars. aria-hidden throughout: they are the rail's texture, and the
          rail itself carries the accessible name and value. */}
      <div aria-hidden className="absolute inset-0 flex items-center gap-[2px] px-1">
        {peaks && peaks.length > 0 ? (
          peaks.map((p, i) => {
            const past = peaks.length > 1 ? i / (peaks.length - 1) <= at : false;
            const lit = playing && past;
            return (
              <span
                key={i}
                className="flex-1 rounded-full transition-[background,opacity] duration-150"
                style={{
                  height: `${Math.max(6, clamp01(p) * 100)}%`,
                  background: lit
                    ? `hsl(${hue} 90% 72% / 0.85)`
                    : `hsl(${hue} 70% 60% / 0.32)`,
                }}
              />
            );
          })
        ) : (
          <div className="flex h-full w-full items-center justify-between gap-[2px] opacity-40">
            <EqBars bars={bars} height="55%" />
          </div>
        )}
      </div>

      {/* the seek surface, UNDER the overlay: a region drawn on the rail takes
          its own clicks, and every gap between regions still seeks. */}
      {seekable && (
        <div
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(at * 100)}
          aria-valuetext={valueText ? valueText(at) : `${Math.round(at * 100)}%`}
          onKeyDown={onKeyDown}
          onClick={(e) => onSeek?.(fractionAt(e.clientX))}
          className="absolute inset-0 z-10 cursor-pointer rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ outlineColor: `hsl(${hue} 85% 68%)` } as CSSProperties}
        />
      )}
      {!seekable && (
        <span role="group" aria-label={label} className="absolute inset-0 z-0" />
      )}

      {children !== undefined && (
        <div className="pointer-events-none absolute inset-0 z-20">{children}</div>
      )}

      {playing && progress !== undefined && <Playhead progress={at} hue={hue} />}
    </div>
  );
}
