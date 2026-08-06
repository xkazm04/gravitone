"use client";

// The composer's text surface, with the direction VISIBLE in it.
//
// Wave 1 made the emotion model honest (regions over plain text, `[tags]`
// derived on the way out) but left the editing surface undirected: the words in
// the textarea looked identical whether they were whispered or shouted, and the
// only place a user could SEE direction was the lane below. Combining emotions
// across a paragraph is the product's most expressive act and it was invisible
// exactly where the author's eyes were.
//
// The technique is a mirror div: a non-interactive copy of the same characters,
// laid out with the SAME typography and box, painting nothing but backgrounds
// underneath a transparent-background textarea. Two rules keep it honest:
//
//  * ALIGNMENT IS VERIFIED, NOT ASSUMED. A mirror that wraps differently from
//    its textarea paints colour onto the wrong words, which is worse than no
//    colour at all — it is a confident lie about what will be spoken. So the
//    two boxes' laid-out heights are compared after every layout, and the
//    moment they disagree the overlay turns itself OFF and the caller falls
//    back to a plain reading line. Degrade, never misalign.
//  * NOTHING HERE TOUCHES THE STRING. `runs` is pure, the mirror is
//    `aria-hidden`, and the textarea is an ordinary controlled input. Payloads
//    and persistence are untouched by this file existing.
//
// The border lives on the WRAPPER and both inner boxes are borderless, because
// a border width that differs by a pixel is one of the ways a mirror drifts.
// For the same reason the mirror is sized to the textarea's CONTENT width: when
// long text (the 8000-character cap is reachable) gives the textarea a
// scrollbar, its content box narrows and the mirror must narrow with it.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { emotionMeta } from "@/lib/emotions";
import type { ScoreRegion } from "./shared";

/** One painted run of the surface: a slice of the text that is uniformly
 *  directed (or not) and uniformly selected (or not). */
export type TextRun = { start: number; end: number; value?: string; selected: boolean };

/**
 * Slice `text` at every region edge AND every selection edge.
 *
 * Cutting on both sets of boundaries is what lets one pass of spans carry both
 * meanings without any rectangle arithmetic: a run is inside a region or it is
 * not, and it is inside the selection or it is not, and the flow does the
 * positioning. Regions are assumed non-overlapping — the grammar has no nesting
 * and `normalizeRegions` guarantees it — so a run belongs to at most one.
 *
 * A zero-width selection (a bare caret) contributes no boundary: there is
 * nothing to show the user they are about to wrap.
 */
export function runs(
  text: string,
  regions: ScoreRegion[],
  selection?: { start: number; end: number } | null,
): TextRun[] {
  const len = text.length;
  if (len === 0) return [];
  const selFrom = selection ? Math.max(0, Math.min(selection.start, selection.end)) : 0;
  const selTo = selection ? Math.min(len, Math.max(selection.start, selection.end)) : 0;
  const hasSel = !!selection && selTo > selFrom;

  const cuts = new Set<number>([0, len]);
  for (const r of regions) {
    if (r.start > 0 && r.start < len) cuts.add(r.start);
    if (r.end > 0 && r.end < len) cuts.add(r.end);
  }
  if (hasSel) {
    if (selFrom > 0 && selFrom < len) cuts.add(selFrom);
    if (selTo > 0 && selTo < len) cuts.add(selTo);
  }

  const edges = [...cuts].sort((a, b) => a - b);
  const out: TextRun[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    if (end <= start) continue;
    const region = regions.find((r) => r.start <= start && end <= r.end);
    out.push({
      start,
      end,
      value: region?.value,
      selected: hasSel && selFrom <= start && end <= selTo,
    });
  }
  return out;
}

/**
 * How one run is painted.
 *
 * Colour is never the ONLY encoding: a directed run also carries a 2px rule
 * under it, and dark 1px rules down both sides so two ADJACENT regions read as
 * two spans rather than one gradient. All three are `inset` box-shadows, which
 * cost no layout — a real border or padding here would push characters out of
 * step with the textarea and trip the alignment check.
 */
function runStyle(run: TextRun): React.CSSProperties {
  const shadows: string[] = [];
  let background: string | undefined;
  if (run.value) {
    const { hue } = emotionMeta(run.value);
    background = `hsl(${hue} 82% 55% / 0.26)`;
    shadows.push(
      `inset 0 -2px 0 0 hsl(${hue} 88% 62% / 0.95)`,
      "inset 1px 0 0 0 rgba(4,6,12,0.85)",
      "inset -1px 0 0 0 rgba(4,6,12,0.85)",
    );
  }
  if (run.selected) {
    // The selection the picker steals focus away from. A portal dialog blurs the
    // textarea, so the NATIVE highlight vanishes exactly when the user is
    // choosing what to do to it; this is that highlight, drawn by us and
    // therefore still there.
    background = run.value ? background : "rgba(148,180,255,0.22)";
    shadows.push("inset 0 0 0 1px rgba(190,214,255,0.7)");
  }
  return { background, boxShadow: shadows.length ? shadows.join(", ") : undefined };
}

/** Typography and box shared, character for character, by the two layers. The
 *  single source of the mirror's fidelity — change it in one place or not at
 *  all. */
const SHELL = "font-hanken block w-full px-3 py-2 text-sm leading-relaxed";

export default function ScoreText({
  text,
  regions,
  selection,
  onChangeText,
  onSelectionChange,
  onKeyDown,
  onFocus,
  rows = 3,
  disabled = false,
  invalid = false,
  placeholder,
  label,
  textareaRef,
  className = "",
}: {
  /** PLAIN text — the same characters the regions' offsets are counted in. */
  text: string;
  regions: ScoreRegion[];
  /** The range to keep visible while focus is elsewhere. */
  selection?: { start: number; end: number } | null;
  onChangeText: (next: string) => void;
  /** Fired whenever the caret or selection moves, in plain-text offsets. */
  onSelectionChange?: (sel: { start: number; end: number }) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  rows?: number;
  disabled?: boolean;
  /** This text breaks a limit the caller states in its own words nearby. */
  invalid?: boolean;
  placeholder?: string;
  label: string;
  textareaRef?: (el: HTMLTextAreaElement | null) => void;
  className?: string;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  // Starts TRUE so a server render and the first paint agree; the check below
  // demotes it before the user can read a misplaced colour.
  const [aligned, setAligned] = useState(true);
  const [width, setWidth] = useState<number | null>(null);

  const check = useCallback(() => {
    const ta = areaRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    // The textarea's content box narrows when it grows a scrollbar. Mirror that
    // first, then judge the heights — otherwise the gutter alone reads as
    // divergence and switches off a perfectly good overlay.
    const inner = ta.clientWidth;
    if (inner > 0) setWidth((w) => (w === inner ? w : inner));
    // jsdom lays nothing out: every box is 0 tall, which compares equal and
    // leaves the overlay on, which is what a unit test should see.
    setAligned(Math.abs(mirror.scrollHeight - ta.scrollHeight) <= 1);
  }, []);

  useLayoutEffect(check);

  useEffect(() => {
    const ta = areaRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(ta);
    return () => ro.disconnect();
  }, [check]);

  // Web fonts land after first paint and change every wrap. Without this the
  // overlay is judged against the fallback font's layout and then never
  // re-judged.
  useEffect(() => {
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    if (!fonts?.ready) return;
    let live = true;
    void fonts.ready.then(() => { if (live) check(); });
    return () => { live = false; };
  }, [check]);

  const readSelection = () => {
    const el = areaRef.current;
    if (!el || !onSelectionChange) return;
    onSelectionChange({ start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 });
  };

  // The mirror always holds the CHARACTERS — it is the thing being measured, and
  // an emptied mirror could never be measured back into agreement, so switching
  // the overlay off would latch forever. Only the PAINT is withdrawn.
  const parts = runs(text, regions, selection);

  return (
    <div
      className={`relative rounded-xl border border-white/10 bg-black/20 focus-within:border-cyan-400/40 ${disabled ? "opacity-50" : ""} ${className}`}
    >
      {/* The paint layer. Decorative by construction: the same characters are
          already in the textarea above, so a screen reader must not meet them
          twice. */}
      <div
        ref={mirrorRef}
        aria-hidden
        data-testid="score-mirror"
        style={width !== null ? { width } : undefined}
        className={`${SHELL} pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap break-words text-transparent`}
      >
        {parts.map((run) => (
          <span
            key={run.start}
            data-emotion={aligned ? run.value ?? undefined : undefined}
            style={aligned ? runStyle(run) : undefined}
          >
            {text.slice(run.start, run.end)}
          </span>
        ))}
        {/* A trailing newline is not laid out by a div the way it is by a
            textarea; this keeps the last line's height honest. */}
        {"\n"}
      </div>

      <textarea
        ref={(el) => {
          areaRef.current = el;
          textareaRef?.(el);
        }}
        value={text}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChangeText(e.target.value)}
        onSelect={readSelection}
        onKeyUp={readSelection}
        onMouseUp={readSelection}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          const m = mirrorRef.current;
          if (m) m.scrollTop = e.currentTarget.scrollTop;
        }}
        className={`${SHELL} relative resize-none border-0 bg-transparent text-white placeholder:text-white/40 focus:outline-none`}
      />
    </div>
  );
}
