"use client";

// One span drawn on a <Track> — the draggable object the score is made of.
//
// Domain-free on purpose: it is handed offsets, a hue, a caption and a badge,
// so the same primitive draws an emotion region in the score editor and (later)
// a segment on a shared take's rail. It knows nothing about emotions, tags or
// audio.
//
// EVERY interaction has a keyboard equivalent, because a drag-only editor is an
// editor some people cannot use at all:
//   * the body is a button — select it, Enter/Space previews it
//   * each edge is a real ARIA slider over CHARACTER OFFSETS — arrows nudge by
//     one character, shift+arrow by five, Home/End take it to the span's limit
//   * pointer drag on the same handles does the same thing with a mouse

import type { ReactNode } from "react";
import { useRef } from "react";

/** Narrowest a region may draw. A two-character region inside a long line is
 *  otherwise a target nobody can hit with a pointer. */
const MIN_PX = 22;

export type RegionEdge = "start" | "end";

export default function Region({
  start,
  end,
  total,
  hue,
  label,
  text,
  badge,
  index,
  count,
  spanText,
  selected = false,
  previewing = false,
  disabled = false,
  onSelect,
  onPreview,
  onResize,
  offsetAt,
}: {
  /** Character offsets [start, end) into a text of `total` characters. */
  start: number;
  end: number;
  total: number;
  hue: number;
  /** What this region does — the emotion's label. */
  label: string;
  /** The characters it covers, for the caption and the spoken description. */
  text: string;
  badge?: ReactNode;
  index: number;
  count: number;
  /** How this span reads out loud, when the offsets are not characters — a
   *  segment placed in TIME says "0:03 to 0:09", not "characters 3 to 9".
   *  Absent → the character wording, which is what the score editor means. */
  spanText?: string;
  selected?: boolean;
  previewing?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  onPreview?: () => void;
  /** Move one edge to an absolute character offset. */
  onResize?: (edge: RegionEdge, offset: number) => void;
  /** Rail-space pointer x -> character offset, owned by the rail. Absent →
   *  pointer dragging is off and only the keyboard path is offered. */
  offsetAt?: (clientX: number) => number;
}) {
  const dragging = useRef<RegionEdge | null>(null);
  const span = Math.max(1, total);
  const left = (Math.max(0, Math.min(total, start)) / span) * 100;
  const width = (Math.max(0, Math.min(total, end) - Math.min(total, start)) / span) * 100;

  const describe = [
    `Region ${index + 1} of ${count}`,
    label,
    spanText ?? `characters ${start} to ${end}`,
    text ? `text: ${text}` : null,
  ].filter(Boolean).join(", ");

  function nudge(e: React.KeyboardEvent, edge: RegionEdge) {
    if (!onResize || disabled) return;
    const step = e.shiftKey ? 5 : 1;
    const from = edge === "start" ? start : end;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowUp" ? from + step
      : e.key === "ArrowLeft" || e.key === "ArrowDown" ? from - step
      : e.key === "Home" ? (edge === "start" ? 0 : start + 1)
      : e.key === "End" ? (edge === "start" ? end - 1 : total)
      : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    onResize(edge, to);
  }

  function startDrag(e: React.PointerEvent, edge: RegionEdge) {
    if (!onResize || !offsetAt || disabled) return;
    e.preventDefault();
    e.stopPropagation();
    dragging.current = edge;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onDrag(e: React.PointerEvent, edge: RegionEdge) {
    if (dragging.current !== edge || !onResize || !offsetAt) return;
    onResize(edge, offsetAt(e.clientX));
  }

  function endDrag(e: React.PointerEvent) {
    if (!dragging.current) return;
    dragging.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  const handle = (edge: RegionEdge) => (
    <span
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={`${label} region ${edge === "start" ? "start" : "end"}, character offset`}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={edge === "start" ? start : end}
      aria-valuetext={`character ${edge === "start" ? start : end} of ${total}`}
      aria-disabled={disabled || undefined}
      onKeyDown={(e) => nudge(e, edge)}
      onPointerDown={(e) => startDrag(e, edge)}
      onPointerMove={(e) => onDrag(e, edge)}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(e) => e.stopPropagation()}
      className={`absolute inset-y-0 z-10 w-2 touch-none rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 ${
        disabled ? "cursor-default" : "cursor-ew-resize"
      } ${edge === "start" ? "-left-1" : "-right-1"}`}
      style={{
        background: `hsl(${hue} 90% 72% / ${selected ? 0.9 : 0.45})`,
        outlineColor: `hsl(${hue} 85% 68%)`,
      }}
    />
  );

  return (
    <div
      className="pointer-events-auto absolute inset-y-1"
      style={{ left: `${left}%`, width: `${width}%`, minWidth: MIN_PX }}
    >
      <button
        type="button"
        onClick={() => { onSelect?.(); onPreview?.(); }}
        aria-pressed={selected}
        aria-label={describe}
        title={text || label}
        disabled={disabled}
        className="relative flex h-full w-full items-center gap-1 overflow-hidden rounded-lg border px-1.5 text-left transition hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed"
        style={{
          background: `linear-gradient(180deg, hsl(${hue} 82% 62% / ${selected ? 0.36 : 0.18}), hsl(${hue} 82% 45% / ${selected ? 0.24 : 0.08}))`,
          borderColor: selected ? `hsl(${hue} 85% 70% / 0.85)` : `hsl(${hue} 70% 60% / 0.3)`,
          outlineColor: `hsl(${hue} 85% 68%)`,
        }}
      >
        {badge && (
          // 18px, and NOT clipped to a circle: a 16px stroke icon is the badge
          // callers hand in now, and a 16px round mask cut its corners off.
          <span aria-hidden className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md bg-black/45">
            {badge}
          </span>
        )}
        <span className="font-jetbrains truncate text-[10px] leading-none text-white/85">
          {label}
        </span>
        {previewing && (
          <span aria-hidden className="ml-auto shrink-0 text-[10px] leading-none text-white/70">
            {"▶"}
          </span>
        )}
      </button>
      {onResize && handle("start")}
      {onResize && handle("end")}
    </div>
  );
}
