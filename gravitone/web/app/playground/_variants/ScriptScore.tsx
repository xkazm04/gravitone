"use client";

// The scene — a multi-character script read as a score instead of as a stack of
// textboxes.
//
// `ScoreEditor` made ONE line directable. A performance is not one line: it is a
// sequence of lines, each spoken by a different Character, and the console draws
// that as N textareas whose only visible difference is a dropdown. Stacked
// LANES — one <Track> per line, tinted by that Character's own hue, sequenced
// top to bottom — turn the same data into something you can read at a glance:
// who speaks, for how many words, and where the direction sits inside each line.
//
// The rules it inherits from the solo editor, deliberately unchanged:
//
//  * The STRING stays the contract. Each lane parses its line's raw text with
//    `parseTags` and writes it back with `toTags`. Nothing new is sent, nothing
//    new is stored, and turning the score off loses nothing.
//  * Regions are DERIVED, never held. The composer owns the text; a lane holds
//    no offsets of its own, so an edit made in the textarea cannot leave a lane
//    pointing at words that moved — there is nothing to drift.
//  * Every pointer act has a keyboard equal: lanes are a roving arrow-key list,
//    edges are ARIA sliders (from <Region>), and the inspector states the same
//    offsets as numbers.
//  * A refusal is a sentence (`regionProblem`), never a silently dropped edit.
//
// One lane is `ScriptLane`; this file is the SCENE around it — the list, the
// roving focus that walks it, and every edit written back to the console's
// strings.

import { useEffect, useMemo, useRef, useState } from "react";
import { emotionMeta } from "@/lib/emotions";
import { resizeRegions, retagRegions } from "./scoreEdits";
import ScriptLane from "./ScriptLane";
import {
  characterHue, parseTags, regionProblem, scoreRegion, toTags,
  type ScoreRegion, type ScriptLine,
} from "./shared";

/** Offered when neither the scale nor the line carries anything, so the
 *  placement control is never an empty dropdown beside an enabled button. */
const FALLBACK_CHOICE = "excited";

type Selection = { lineId: string; index: number };

/** Whether this visitor asked for less movement. Read at interaction time
 *  rather than cached: the OS setting can change while the tab is open, and the
 *  global stylesheet already kills CSS animation — this covers the one motion
 *  the browser would otherwise animate for us (bringing a lane into view). */
function reducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function ScriptScore({
  lines,
  onChangeLine,
  characterName,
  availableFor,
  scale = [],
  activeLineId,
  onFocusLine,
  disabled = false,
  className = "",
}: {
  /** The composer's script, raw text and all. This is the contract. */
  lines: ScriptLine[];
  /** Write one line's text back — metatags included. */
  onChangeLine: (id: string, next: string) => void;
  /** Display name for a Character id. Absent → the id, which is still true. */
  characterName?: (characterId: string) => string;
  /** What that Character has actually recorded, for the honest (dim) badge. */
  availableFor?: (characterId: string) => string[];
  /** The emotions offered for placement. */
  scale?: string[];
  /** Which line the composer is on — the lane is highlighted and brought into
   *  view, so the two views never disagree about where you are. */
  activeLineId?: string;
  /** Focus (and scroll to) that line in the composer. Absent → lanes do not
   *  claim to be a way of getting there. */
  onFocusLine?: (id: string, index: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [selected, setSelected] = useState<Selection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string>("");

  const laneRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  /** Each line as plain text + its regions. Recomputed from the strings the
   *  console holds, which is why nothing here can go stale. */
  const parsed = useMemo(
    () => lines.map((l) => ({ line: l, ...parseTags(l.text) })),
    [lines],
  );

  const choices = useMemo(() => {
    const seen = new Set<string>(scale);
    for (const p of parsed) for (const r of p.regions) seen.add(r.value);
    seen.delete("baseline");
    if (seen.size === 0) seen.add(FALLBACK_CHOICE);
    return [...seen];
  }, [scale, parsed]);

  const emotion = choices.includes(pending) ? pending : choices[0];

  // The composer moved: follow it. `block: "nearest"` so a lane already on
  // screen does not shove the page around.
  useEffect(() => {
    if (!activeLineId) return;
    const i = lines.findIndex((l) => l.id === activeLineId);
    const row = rowRefs.current[i];
    // Feature-detected: bringing a lane into view is a courtesy, and an
    // environment without scrollIntoView (jsdom, very old engines) must lose the
    // courtesy, not the score.
    if (typeof row?.scrollIntoView !== "function") return;
    row.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" });
  }, [activeLineId, lines]);

  /** Write a lane's regions back onto its line. */
  function emit(i: number, regions: ScoreRegion[]) {
    const p = parsed[i];
    if (!p) return;
    onChangeLine(p.line.id, toTags(p.text, regions));
  }

  function focusLine(i: number) {
    const p = parsed[i];
    if (!p) return;
    setSelected(null);
    onFocusLine?.(p.line.id, i);
  }

  /** Lanes are one list: up and down walk it, Home/End jump to its ends. */
  function laneKeys(e: React.KeyboardEvent, i: number) {
    const to =
      e.key === "ArrowDown" ? i + 1
      : e.key === "ArrowUp" ? i - 1
      : e.key === "Home" ? 0
      : e.key === "End" ? lines.length - 1
      : null;
    if (to === null || to < 0 || to >= lines.length) return;
    e.preventDefault();
    laneRefs.current[to]?.focus();
  }

  function addWholeLine(i: number) {
    const p = parsed[i];
    if (!p) return;
    // The lane has no text selection of its own — the words live in the
    // composer — so the one placement it can offer without guessing is the
    // WHOLE line. Drag or nudge it in from there.
    const candidate = scoreRegion(0, p.text.length, emotion);
    const why = regionProblem(p.text, candidate, p.regions);
    if (why) { setNotice(why); return; }
    setNotice(null);
    const next = [...p.regions, candidate].sort((a, b) => a.start - b.start);
    setSelected({ lineId: p.line.id, index: next.indexOf(candidate) });
    emit(i, next);
  }

  function resize(i: number, index: number, edge: "start" | "end", to: number) {
    const p = parsed[i];
    if (!p) return;
    const next = resizeRegions(p.text, p.regions, index, edge, to);
    if (!next) return;
    setNotice(null);
    emit(i, next);
  }

  function retag(i: number, index: number, value: string) {
    const p = parsed[i];
    if (!p) return;
    const { regions: next, why } = retagRegions(p.text, p.regions, index, value);
    if (why) { setNotice(why); return; }
    if (!next) return;
    setNotice(null);
    emit(i, next);
  }

  function remove(i: number, index: number) {
    const p = parsed[i];
    const r = p?.regions[index];
    if (!p || !r) return;
    setSelected(null);
    setNotice(`Removed the ${emotionMeta(r.value).label} region from line ${i + 1} — those words return to ${nameOf(p.line.characterId)}'s baseline.`);
    emit(i, p.regions.filter((_, j) => j !== index));
  }

  const nameOf = (id: string) => characterName?.(id) ?? id;
  const directed = parsed.reduce((n, p) => n + p.regions.length, 0);

  if (lines.length === 0) return null; // absent = invisible

  return (
    <section aria-label="Script score" className={`space-y-2 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          scene · {lines.length} line{lines.length === 1 ? "" : "s"} · {directed} directed span
          {directed === 1 ? "" : "s"}
        </span>
        <span className="font-jetbrains text-[10px] text-white/40">
          one lane per line, tinted by Character · direction is written back as [tags]
        </span>
      </div>

      {parsed.map((p, i) => (
        <ScriptLane
          key={p.line.id}
          index={i}
          text={p.text}
          regions={p.regions}
          name={nameOf(p.line.characterId)}
          hue={characterHue(p.line.characterId)}
          active={activeLineId === p.line.id}
          available={availableFor?.(p.line.characterId) ?? []}
          choices={choices}
          emotion={emotion}
          selected={selected?.lineId === p.line.id ? selected.index : null}
          disabled={disabled}
          focusable={!!onFocusLine}
          rowRef={(el) => { rowRefs.current[i] = el; }}
          laneRef={(el) => { laneRefs.current[i] = el; }}
          onFocus={() => focusLine(i)}
          onLaneKeys={(e) => laneKeys(e, i)}
          onSelectRegion={(index) => { setSelected({ lineId: p.line.id, index }); setNotice(null); }}
          onAddWholeLine={() => addWholeLine(i)}
          onResize={(index, edge, to) => resize(i, index, edge, to)}
          onRetag={(index, value) => retag(i, index, value)}
          onRemove={(index) => remove(i, index)}
          onPending={setPending}
        />
      ))}

      {/* One live region for every refusal and removal above. */}
      <p aria-live="polite" className="font-jetbrains min-h-[1rem] text-[11px] leading-relaxed text-amber-200/90">
        {notice}
      </p>
    </section>
  );
}
