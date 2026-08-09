"use client";

// The lane strip — the place you GRAB a span.
//
// Split out of ScoreEditor with its rail ref and the x -> offset conversion
// that reads it: a drag is measured against this element's box, so the
// measurement and the element it measures stay in one file.

import { useRef } from "react";
import EmotionIcon from "@/components/ui/EmotionIcon";
import Region from "@/components/ui/Region";
import Track from "@/components/ui/Track";
import { emotionMeta } from "@/lib/emotions";
import type { ScoreRegion } from "./playgroundHelpers";

/** How the lane is drawn. A STRIP attached to the text, not a section under it:
 *  40px with its own heading and its own empty-state box read as a second
 *  panel, and the composer's vertical stack was already three panels too long.
 *  28 is the floor a <Region> stays grabbable at (it insets 4px top and bottom,
 *  and its badge is 18). */
const LANE_HEIGHT = 28;

export default function ScoreLane({
  text,
  regions,
  available,
  selected,
  previewIndex,
  disabled = false,
  onSelect,
  onPreview,
  onResize,
}: {
  /** PLAIN text — the same characters the regions' offsets are counted in. */
  text: string;
  regions: ScoreRegion[];
  /** Emotions this Character has actually recorded (for the honest badge). */
  available: string[];
  selected: number | null;
  /** Which region is sounding right now, if any. */
  previewIndex: number | null;
  disabled?: boolean;
  onSelect: (index: number) => void;
  onPreview: (index: number) => void;
  onResize: (index: number, edge: "start" | "end", to: number) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);

  /** Rail x -> character offset, so a drag and an arrow key move the same edge
   *  through the same coordinate space. */
  const offsetAt = (clientX: number): number => {
    const box = railRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return Math.round(f * text.length);
  };

  return (
    <div className="space-y-1">
      <div ref={railRef}>
        <Track label={`Emotion regions over ${text.length} characters`} height={LANE_HEIGHT} bars={0}>
          {regions.map((r, i) => {
            const m = emotionMeta(r.value);
            return (
              <Region
                // Keyed by POSITION IN THE SCORE, not by offsets: a key that
                // changed on every nudge remounted the region and threw
                // keyboard focus off the handle mid-resize, so one arrow press
                // was all you got. Regions are always sorted, so the index is
                // stable for as long as the region exists.
                key={i}
                start={r.start}
                end={r.end}
                total={text.length}
                hue={m.hue}
                label={m.label}
                text={text.slice(r.start, r.end)}
                index={i}
                count={regions.length}
                selected={selected === i}
                previewing={previewIndex === i}
                disabled={disabled}
                badge={<EmotionIcon emotion={r.value} size={16} dim={!available.includes(r.value)} />}
                onSelect={() => onSelect(i)}
                onPreview={() => onPreview(i)}
                onResize={(edge, to) => onResize(i, edge, to)}
                offsetAt={offsetAt}
              />
            );
          })}
        </Track>
      </div>
      {regions.length === 0 && (
        <p className="font-jetbrains px-0.5 text-[10px] leading-relaxed text-white/45">
          No direction yet — the whole line is spoken in the Character&apos;s baseline Voice.
          Select words above, then direct them below.
        </p>
      )}
    </div>
  );
}
