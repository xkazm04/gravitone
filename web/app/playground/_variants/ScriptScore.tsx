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

import { useEffect, useMemo, useRef, useState } from "react";
import EmotionArt from "@/components/ui/EmotionArt";
import Region from "@/components/ui/Region";
import Track from "@/components/ui/Track";
import { emotionMeta } from "@/lib/emotions";
import {
  characterHue, parseTags, regionProblem, scoreRegion, toTags,
  type ScoreRegion, type ScriptLine,
} from "./shared";

/** Lane height. Shorter than the solo lane: a 12-line scene has to stay one
 *  readable object, not twelve editors. */
const LANE_HEIGHT = 34;

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
  const railRefs = useRef<Array<HTMLDivElement | null>>([]);
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
    const r = p?.regions[index];
    if (!p || !r) return;
    const floor = index > 0 ? p.regions[index - 1].end : 0;
    const ceil = index < p.regions.length - 1 ? p.regions[index + 1].start : p.text.length;
    const next =
      edge === "start"
        ? scoreRegion(Math.max(floor, Math.min(to, r.end - 1)), r.end, r.value)
        : scoreRegion(r.start, Math.min(ceil, Math.max(to, r.start + 1)), r.value);
    if (next.start === r.start && next.end === r.end) return;
    setNotice(null);
    emit(i, p.regions.map((x, j) => (j === index ? next : x)));
  }

  function retag(i: number, index: number, value: string) {
    const p = parsed[i];
    const r = p?.regions[index];
    if (!p || !r) return;
    const why = regionProblem(
      p.text,
      scoreRegion(r.start, r.end, value),
      p.regions.filter((_, j) => j !== index),
    );
    if (why) { setNotice(why); return; }
    setNotice(null);
    emit(i, p.regions.map((x, j) => (j === index ? scoreRegion(x.start, x.end, value) : x)));
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

      {parsed.map((p, i) => {
        const hue = characterHue(p.line.characterId);
        const active = activeLineId === p.line.id;
        const available = availableFor?.(p.line.characterId) ?? [];
        const sel = selected?.lineId === p.line.id ? selected.index : null;
        const chosen = sel !== null ? p.regions[sel] : undefined;

        /** Rail x -> character offset for THIS lane, so a drag and an arrow key
         *  move the same edge through the same coordinate space. */
        const offsetAt = (clientX: number): number => {
          const box = railRefs.current[i]?.getBoundingClientRect();
          if (!box || box.width <= 0) return 0;
          const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
          return Math.round(f * p.text.length);
        };

        return (
          <div
            key={p.line.id}
            ref={(el) => { rowRefs.current[i] = el; }}
            className={`rounded-xl border px-2.5 py-2 transition ${
              active ? "border-cyan-400/25 bg-cyan-400/[0.03]" : "border-white/10 bg-white/[0.02]"
            }`}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <button
                type="button"
                ref={(el) => { laneRefs.current[i] = el; }}
                onClick={() => focusLine(i)}
                onKeyDown={(e) => laneKeys(e, i)}
                aria-label={`Line ${i + 1}, ${nameOf(p.line.characterId)}${onFocusLine ? " — focus it in the composer" : ""}`}
                aria-current={active || undefined}
                className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 text-left transition hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-1"
                style={{ outlineColor: `hsl(${hue} 85% 68%)` }}
              >
                <span className="font-jetbrains w-4 shrink-0 text-[11px] text-white/40">{i + 1}</span>
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 shrink-0 rounded-full"
                  style={{ background: `radial-gradient(circle at 30% 30%, hsl(${hue} 90% 72%), hsl(${hue} 80% 45%))` }}
                />
                <span className="font-jetbrains truncate text-[11px] text-white/75">
                  {nameOf(p.line.characterId)}
                </span>
              </button>
              <span className="font-jetbrains ml-auto shrink-0 text-[10px] text-white/35">
                {p.text.length} char{p.text.length === 1 ? "" : "s"}
                {p.regions.length > 0 && ` · ${p.regions.length} directed`}
              </span>
            </div>

            {p.text.length === 0 ? (
              <p className="font-jetbrains rounded-lg border border-dashed border-white/10 px-2 py-1.5 text-[10px] text-white/40">
                No words on this line yet — type it in the composer and its lane appears here.
              </p>
            ) : (
              <div ref={(el) => { railRefs.current[i] = el; }}>
                <Track
                  label={`Line ${i + 1}, ${nameOf(p.line.characterId)} — ${p.regions.length} directed span${p.regions.length === 1 ? "" : "s"} over ${p.text.length} characters`}
                  height={LANE_HEIGHT}
                  hue={hue}
                  bars={0}
                >
                  {p.regions.map((r, index) => {
                    const m = emotionMeta(r.value);
                    return (
                      <Region
                        // Keyed by POSITION, not by offsets — an offset key
                        // remounts the region on every nudge and throws
                        // keyboard focus off the handle mid-resize.
                        key={index}
                        start={r.start}
                        end={r.end}
                        total={p.text.length}
                        hue={m.hue}
                        label={m.label}
                        text={p.text.slice(r.start, r.end)}
                        index={index}
                        count={p.regions.length}
                        selected={sel === index}
                        disabled={disabled}
                        badge={<EmotionArt emotion={r.value} size={12} dim={!available.includes(r.value)} />}
                        onSelect={() => { setSelected({ lineId: p.line.id, index }); setNotice(null); }}
                        onResize={(edge, to) => resize(i, index, edge, to)}
                        offsetAt={offsetAt}
                      />
                    );
                  })}
                </Track>
              </div>
            )}

            {/* Placement + the numeric path, for the lane you are ON only: a
                scene of sixty lines must not be sixty inspectors. */}
            {(active || sel !== null) && p.text.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <select
                  value={chosen ? chosen.value : emotion}
                  disabled={disabled}
                  onChange={(e) => (sel !== null ? retag(i, sel, e.target.value) : setPending(e.target.value))}
                  aria-label={sel !== null ? `Emotion for the selected region on line ${i + 1}` : `Emotion to direct line ${i + 1} with`}
                  className="font-jetbrains rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[11px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
                >
                  {[...new Set([...(chosen ? [chosen.value] : []), ...choices])].map((id) => (
                    <option key={id} value={id} className="bg-slate-900 text-white">
                      {emotionMeta(id).label}
                      {available.length > 0 && !available.includes(id) ? " (not recorded)" : ""}
                    </option>
                  ))}
                </select>

                {chosen && sel !== null ? (
                  <>
                    <label className="font-jetbrains flex items-center gap-1 text-[10px] text-white/50">
                      from
                      <input
                        type="number"
                        min={0}
                        max={chosen.end - 1}
                        value={chosen.start}
                        disabled={disabled}
                        onChange={(e) => resize(i, sel, "start", Number(e.target.value))}
                        aria-label={`Region start on line ${i + 1}, character offset`}
                        className="font-jetbrains w-14 rounded-lg border border-white/15 bg-black/40 px-1.5 py-1 text-[11px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
                      />
                    </label>
                    <label className="font-jetbrains flex items-center gap-1 text-[10px] text-white/50">
                      to
                      <input
                        type="number"
                        min={chosen.start + 1}
                        max={p.text.length}
                        value={chosen.end}
                        disabled={disabled}
                        onChange={(e) => resize(i, sel, "end", Number(e.target.value))}
                        aria-label={`Region end on line ${i + 1}, character offset`}
                        className="font-jetbrains w-14 rounded-lg border border-white/15 bg-black/40 px-1.5 py-1 text-[11px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => remove(i, sel)}
                      disabled={disabled}
                      className="font-jetbrains rounded-full border border-white/15 px-2.5 py-1 text-[10px] text-white/60 transition enabled:hover:border-rose-400/40 enabled:hover:text-rose-200 disabled:opacity-40"
                    >
                      delete
                    </button>
                    <span className="font-jetbrains text-[10px] text-white/35">
                      {available.length > 0 && !available.includes(chosen.value)
                        ? `${emotionMeta(chosen.value).label} is not recorded for ${nameOf(p.line.characterId)} — the nearest recorded emotion is used, then baseline.`
                        : "drag an edge, nudge with the arrow keys, or type an offset"}
                    </span>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => addWholeLine(i)}
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
      })}

      {/* One live region for every refusal and removal above. */}
      <p aria-live="polite" className="font-jetbrains min-h-[1rem] text-[11px] leading-relaxed text-amber-200/90">
        {notice}
      </p>
    </section>
  );
}
