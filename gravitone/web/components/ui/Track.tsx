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
//   * click-, drag- and keyboard-to-seek, as a real ARIA slider so the rail is
//     operable from the keyboard and not only from a mouse,
//   * an overlay for whatever the caller wants placed ON the rail (regions).
//
// It is PURELY presentational: it owns no audio, no player and no data. It is
// handed numbers and hands back a fraction.

import type { CSSProperties, ReactNode } from "react";
import { EqBars } from "./Equalizer";
import { Playhead } from "./TrackPlayhead";
import { clamp01 } from "./trackHelpers";
import { useTrackSeek } from "./useTrackSeek";

export { clock } from "./trackHelpers";
export { Playhead } from "./TrackPlayhead";

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
  const at = clamp01(progress ?? 0);
  const seekable = !!onSeek;
  const { railRef, fractionAt, onPointerDown, onPointerMove, endScrub, onKeyDown } =
    useTrackSeek(at, onSeek);

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
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          className="absolute inset-0 z-10 touch-none cursor-pointer rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2"
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
