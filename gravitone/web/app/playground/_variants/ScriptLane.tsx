"use client";

// One line of the scene, drawn as a lane.
//
// Everything about a single line lives here — who speaks it, the rail its
// directed spans sit on, and the placement/numeric controls that appear only
// for the lane you are on. ScriptScore keeps the scene: the list, the roving
// focus between lanes, and the strings all of them are written back to.
//
// The rail's ref and the x -> offset conversion that reads it are in this file
// together, because a drag is measured against THIS lane's box and a
// measurement kept away from the element it measures is a bug waiting for a
// layout change.

import { useRef } from "react";
import EmotionIcon from "@/components/ui/EmotionIcon";
import Region from "@/components/ui/Region";
import Track from "@/components/ui/Track";
import { emotionMeta } from "@/lib/emotions";
import type { ScoreRegion } from "./shared";

/** Lane height. Shorter than the solo lane: a 12-line scene has to stay one
 *  readable object, not twelve editors. */
const LANE_HEIGHT = 34;

export default function ScriptLane({
  index,
  text,
  regions,
  name,
  hue,
  active,
  available,
  choices,
  emotion,
  selected,
  disabled = false,
  focusable,
  rowRef,
  laneRef,
  onFocus,
  onLaneKeys,
  onSelectRegion,
  onAddWholeLine,
  onResize,
  onRetag,
  onRemove,
  onPending,
}: {
  /** Where this line sits in the scene. Every label counts from `index + 1`. */
  index: number;
  /** The line's PLAIN text — the characters its offsets are counted in. */
  text: string;
  regions: ScoreRegion[];
  /** Display name for this line's Character. */
  name: string;
  /** That Character's own hue, so a scene reads as who-speaks-when. */
  hue: number;
  /** The composer is on this line. */
  active: boolean;
  /** What the Character has actually recorded, for the honest (dim) badge. */
  available: string[];
  /** The emotions offered for placement. */
  choices: string[];
  /** The one that will be placed if nothing is selected. */
  emotion: string;
  /** Which of this lane's regions is selected, if any. */
  selected: number | null;
  disabled?: boolean;
  /** The scene can take you to this line in the composer — said in the lane's
   *  own accessible name, so it never claims a way of getting there it lacks. */
  focusable: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
  laneRef: (el: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onLaneKeys: (e: React.KeyboardEvent) => void;
  onSelectRegion: (index: number) => void;
  onAddWholeLine: () => void;
  onResize: (index: number, edge: "start" | "end", to: number) => void;
  onRetag: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onPending: (value: string) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const chosen = selected !== null ? regions[selected] : undefined;

  /** Rail x -> character offset for THIS lane, so a drag and an arrow key
   *  move the same edge through the same coordinate space. */
  const offsetAt = (clientX: number): number => {
    const box = railRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return Math.round(f * text.length);
  };

  return (
    <div
      ref={rowRef}
      className={`rounded-xl border px-2.5 py-2 transition ${
        active ? "border-cyan-400/25 bg-cyan-400/[0.03]" : "border-white/10 bg-white/[0.02]"
      }`}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <button
          type="button"
          ref={laneRef}
          onClick={onFocus}
          onKeyDown={onLaneKeys}
          aria-label={`Line ${index + 1}, ${name}${focusable ? " — focus it in the composer" : ""}`}
          aria-current={active || undefined}
          className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 text-left transition hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-1"
          style={{ outlineColor: `hsl(${hue} 85% 68%)` }}
        >
          <span className="font-jetbrains w-4 shrink-0 text-[11px] text-white/40">{index + 1}</span>
          <span
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 rounded-full"
            style={{ background: `radial-gradient(circle at 30% 30%, hsl(${hue} 90% 72%), hsl(${hue} 80% 45%))` }}
          />
          <span className="font-jetbrains truncate text-[11px] text-white/75">
            {name}
          </span>
        </button>
        <span className="font-jetbrains ml-auto shrink-0 text-[10px] text-white/35">
          {text.length} char{text.length === 1 ? "" : "s"}
          {regions.length > 0 && ` · ${regions.length} directed`}
        </span>
      </div>

      {text.length === 0 ? (
        <p className="font-jetbrains rounded-lg border border-dashed border-white/10 px-2 py-1.5 text-[10px] text-white/40">
          No words on this line yet — type it in the composer and its lane appears here.
        </p>
      ) : (
        <div ref={railRef}>
          <Track
            label={`Line ${index + 1}, ${name} — ${regions.length} directed span${regions.length === 1 ? "" : "s"} over ${text.length} characters`}
            height={LANE_HEIGHT}
            hue={hue}
            bars={0}
          >
            {regions.map((r, i) => {
              const m = emotionMeta(r.value);
              return (
                <Region
                  // Keyed by POSITION, not by offsets — an offset key
                  // remounts the region on every nudge and throws
                  // keyboard focus off the handle mid-resize.
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
                  disabled={disabled}
                  badge={<EmotionIcon emotion={r.value} size={16} dim={!available.includes(r.value)} />}
                  onSelect={() => onSelectRegion(i)}
                  onResize={(edge, to) => onResize(i, edge, to)}
                  offsetAt={offsetAt}
                />
              );
            })}
          </Track>
        </div>
      )}

      {/* Placement + the numeric path, for the lane you are ON only: a
          scene of sixty lines must not be sixty inspectors. */}
      {(active || selected !== null) && text.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <select
            value={chosen ? chosen.value : emotion}
            disabled={disabled}
            onChange={(e) => (selected !== null ? onRetag(selected, e.target.value) : onPending(e.target.value))}
            aria-label={selected !== null ? `Emotion for the selected region on line ${index + 1}` : `Emotion to direct line ${index + 1} with`}
            className="font-jetbrains rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[11px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
          >
            {[...new Set([...(chosen ? [chosen.value] : []), ...choices])].map((id) => (
              <option key={id} value={id} className="bg-slate-900 text-white">
                {emotionMeta(id).label}
                {available.length > 0 && !available.includes(id) ? " (not recorded)" : ""}
              </option>
            ))}
          </select>

          {chosen && selected !== null ? (
            <>
              <label className="font-jetbrains flex items-center gap-1 text-[10px] text-white/50">
                from
                <input
                  type="number"
                  min={0}
                  max={chosen.end - 1}
                  value={chosen.start}
                  disabled={disabled}
                  onChange={(e) => onResize(selected, "start", Number(e.target.value))}
                  aria-label={`Region start on line ${index + 1}, character offset`}
                  className="font-jetbrains w-14 rounded-lg border border-white/15 bg-black/40 px-1.5 py-1 text-[11px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
                />
              </label>
              <label className="font-jetbrains flex items-center gap-1 text-[10px] text-white/50">
                to
                <input
                  type="number"
                  min={chosen.start + 1}
                  max={text.length}
                  value={chosen.end}
                  disabled={disabled}
                  onChange={(e) => onResize(selected, "end", Number(e.target.value))}
                  aria-label={`Region end on line ${index + 1}, character offset`}
                  className="font-jetbrains w-14 rounded-lg border border-white/15 bg-black/40 px-1.5 py-1 text-[11px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
                />
              </label>
              <button
                type="button"
                onClick={() => onRemove(selected)}
                disabled={disabled}
                className="font-jetbrains rounded-full border border-white/15 px-2.5 py-1 text-[10px] text-white/60 transition enabled:hover:border-rose-400/40 enabled:hover:text-rose-200 disabled:opacity-40"
              >
                delete
              </button>
              <span className="font-jetbrains text-[10px] text-white/35">
                {available.length > 0 && !available.includes(chosen.value)
                  ? `${emotionMeta(chosen.value).label} is not recorded for ${name} — the nearest recorded emotion is used, then baseline.`
                  : "drag an edge, nudge with the arrow keys, or type an offset"}
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onAddWholeLine}
                disabled={disabled}
                className="font-jetbrains rounded-full border border-cyan-400/30 bg-cyan-400/5 px-2.5 py-1 text-[10px] text-cyan-200 transition enabled:hover:bg-cyan-400/10 disabled:opacity-40"
              >
                + direct this whole line
              </button>
              <span className="font-jetbrains text-[10px] text-white/35">
                then drag or nudge its edges in — or select words in the composer and use the
                solo score
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
