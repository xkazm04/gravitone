"use client";

// The segment timeline — a take's structure, drawn from data it already
// carries.
//
// Every gravitone take arrives with a per-segment report (X-Segments /
// X-Performance-Report): the text, the emotion that actually ran, and how long
// it took. Cumulative seconds place each segment in time, so this needs no
// backend call and no decode: the ribbon of chips the card already draws is the
// same data WITHOUT its position, and position is what makes a take editable.
//
// Regions are buttons, not divs: clicking one seeks the take to it and selects
// it for punch-in, arrows move between them, Enter/Space activates — the whole
// editor is reachable from the keyboard because its entry point is.

import { useRef } from "react";
import { emotionMeta } from "@/lib/emotions";
import type { Region, Take } from "./playgroundHelpers";

/** Narrowest a region may draw. A one-word segment inside a 60-second
 *  performance is otherwise a sub-pixel target nobody can hit. */
const MIN_REGION_PX = 10;

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  return `${Math.floor(seconds / 60)}:${s < 10 ? "0" : ""}${s}`;
}

export default function TakeTimeline({
  take,
  regions,
  selected,
  onPick,
  progress = 0,
  playing = false,
  characterName,
}: {
  take: Take;
  /** Placed segments — shared.segmentRegions(take.segments, duration). */
  regions: Region[];
  /** Which region is currently the punch-in target (null = none). */
  selected: number | null;
  /** Seek to this region AND make it the punch-in target. */
  onPick: (index: number) => void;
  /** 0..1 playhead, when this take is the one playing. */
  progress?: number;
  playing?: boolean;
  /** Resolve a segment's Character id to a name (performance takes). */
  characterName?: (id: string) => string;
}) {
  const refs = useRef<Map<number, HTMLButtonElement>>(new Map());

  if (regions.length === 0) return null;
  const total = regions[regions.length - 1].end || take.seconds || 1;

  /** Roving arrow navigation across the regions, same grammar as the character
   *  rail: arrows move focus, Enter/Space does the seeking, so focus alone never
   *  moves the playhead by accident. */
  function onKey(e: React.KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = regions.length - 1;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (i === last ? 0 : i + 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i === 0 ? last : i - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : -1;
    if (to < 0) return;
    e.preventDefault();
    refs.current.get(to)?.focus();
  }

  return (
    <div className="mt-3">
      <div
        role="group"
        aria-label={`Segment timeline — ${regions.length} segment${regions.length === 1 ? "" : "s"}, ${clock(total)}`}
        className="relative flex h-11 w-full items-stretch gap-[2px] overflow-hidden rounded-lg border border-white/10 bg-black/30 p-[2px]"
      >
        {regions.map((r) => {
          const m = emotionMeta(r.segment.used);
          const on = selected === r.index;
          const share = Math.max(0, (r.end - r.start) / total);
          const who = r.segment.characterId && characterName ? characterName(r.segment.characterId) : null;
          const label = [
            `Segment ${r.index + 1} of ${regions.length}`,
            who ? `spoken by ${who}` : null,
            `${m.label}${r.segment.fallback ? ` (substituted for ${r.segment.requested})` : ""}`,
            `starts at ${clock(r.start)}`,
            `${Math.round((r.end - r.start) * 10) / 10} seconds`,
            r.segment.text ? `text: ${r.segment.text}` : null,
          ].filter(Boolean).join(", ");
          return (
            <button
              key={r.index}
              ref={(el) => {
                if (el) refs.current.set(r.index, el);
                else refs.current.delete(r.index);
              }}
              type="button"
              onClick={() => onPick(r.index)}
              onKeyDown={(e) => onKey(e, r.index)}
              tabIndex={on || (selected === null && r.index === 0) ? 0 : -1}
              aria-pressed={on}
              aria-label={label}
              title={r.segment.text || m.label}
              style={{
                flexGrow: share,
                flexBasis: 0,
                minWidth: MIN_REGION_PX,
                background: `linear-gradient(180deg, hsl(${m.hue} 80% 62% / ${on ? 0.34 : 0.16}), hsl(${m.hue} 80% 45% / ${on ? 0.22 : 0.08}))`,
                borderColor: on ? `hsl(${m.hue} 85% 68% / 0.8)` : "transparent",
                outlineColor: `hsl(${m.hue} 85% 68%)`,
              }}
              className="group relative cursor-pointer overflow-hidden rounded-[5px] border text-left transition hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-1"
            >
              <span className="font-jetbrains pointer-events-none absolute inset-x-1 bottom-0.5 truncate text-[9px] leading-none text-white/70">
                {r.segment.text || m.label}
              </span>
              {r.segment.fallback && (
                <span
                  aria-hidden
                  title={`${r.segment.requested} was substituted with ${r.segment.used}`}
                  className="pointer-events-none absolute right-1 top-0.5 text-[9px] leading-none text-amber-300/90"
                >
                  ~
                </span>
              )}
            </button>
          );
        })}
        {/* Playhead. Only drawn while THIS take is playing — a line parked at 0
            on every card would read as a position rather than an absence. */}
        {playing && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-cyan-200/90"
            style={{ left: `${Math.min(100, Math.max(0, progress * 100))}%` }}
          />
        )}
      </div>
      <p className="font-jetbrains mt-1 text-[10px] text-white/45">
        {regions.length} segment{regions.length === 1 ? "" : "s"} · {clock(total)} · click or press Enter on a
        segment to hear it from there
      </p>
    </div>
  );
}
