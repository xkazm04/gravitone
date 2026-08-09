"use client";

// The score — directing a performance as a visual act.
//
// The engine has accepted inline emotion spans since day one, but the only way
// to use them was to remember the `[excited]…[/excited]` syntax and type it into
// a textarea, which is why the most expressive capability in the product was
// invisible unless you read the API docs. Here the same string is a SCORE: the
// text is the horizontal axis, each directed span is an object beneath it
// tinted by its emotion's hue and badged with its icon, and you place one by
// selecting words.
//
// Three rules this component is built around:
//
//  * The STRING stays the contract. Nothing new is sent and nothing new is
//    stored: `value` in, `value` out, bridged by shared.ts's pure
//    parseTags/toTags. A take typed by hand and a take directed here are the
//    same request, and turning the editor off loses nothing.
//  * The keyboard path is not a fallback. Every region can be placed, moved,
//    resized, previewed and deleted without a pointer — drag is the ALTERNATIVE
//    to the numeric fields and the arrow keys, not the other way round.
//  * A region never drifts onto words it was not written for. When an edit
//    changes the words under a region the region is CLEARED and the notice says
//    which one and why (shared.transformRegions).
//  * ONE PANEL PER DECISION. The stack reads text -> lane strip -> direction
//    panel, and that is the whole composer. It used to read text, director row,
//    review list, lane, empty-state box, placement row, inspector box — plus
//    the chip row the console drew below all of it, under a third heading with
//    the word "direct" in it. Everything that DIRECTS now lives in one bordered
//    container, ordered by what it acts on: the selection first (chips, then
//    the same operation named explicitly), the whole text second, the selected
//    region's inspector last, separated by hairlines rather than by boxes.
//
// The pieces it composes live beside it: ScoreText (the painted surface),
// ScoreLane (the strip you grab a span on), ScorePlacement (direct the
// selection), ScoreDirector (propose and review), ScoreInspector (the selected
// region as numbers), ScoreMarkup (the raw string), plus useScorePreview
// (hearing one region), useScoreDirector (the proposal that is not the string)
// and scoreEdits (the arithmetic a lane shares with a scene). This file owns
// the string and every decision made about it.

import { useImperativeHandle, useMemo, useState } from "react";
import { emotionMeta } from "@/lib/emotions";
import ScoreDirector from "./ScoreDirector";
import ScoreInspector from "./ScoreInspector";
import ScoreLane from "./ScoreLane";
import ScoreMarkup from "./ScoreMarkup";
import ScorePlacement from "./ScorePlacement";
import ScoreText from "./ScoreText";
import { resizeRegions, retagRegions } from "./scoreEdits";
import {
  asRegion,
  // Aliased: `retag` is already this component's word for re-aiming a PLACED
  // region, and the two must not be confused — one edits the string, the other
  // edits a proposal that is not in the string yet.
  reject as rejectSuggestion, retag as retagSuggestion,
} from "./suggest";
import {
  applyEmotion, DEFAULT_EXPRESSION, editPlainText, parseTags, toTags,
  wrappedAnnouncement, type Expression, type ScoreRegion,
} from "./shared";
import { useScoreDirector } from "./useScoreDirector";
import { useScorePreview } from "./useScorePreview";

/** What the console can ask of the score from OUTSIDE it — the emotion chips
 *  and the wheel live up there, but the selection they act on lives down here.
 *  One method, so the picker paths and the "+ add region" button are literally
 *  the same operation (shared.applyEmotion). */
export type ScoreEditorHandle = { applyEmotion: (emotion: string) => void };

/** Offered when a Character reports no scale at all, so the placement control
 *  is never an empty dropdown next to an enabled button. */
const FALLBACK_CHOICE = "excited";

export default function ScoreEditor({
  value,
  onChange,
  onSubmit,
  ref,
  characterId,
  available = [],
  scale,
  expr = DEFAULT_EXPRESSION,
  chips,
  disabled = false,
  className = "",
}: {
  /** The composer's raw text — metatags included. This is the contract. */
  value: string;
  onChange: (next: string) => void;
  /** ⌘↵ in the text area. Absent → the shortcut simply does nothing here. */
  onSubmit?: () => void;
  ref?: React.Ref<ScoreEditorHandle>;
  /** Who previews a region. Absent → preview is offered but explained as off. */
  characterId?: string;
  /** Emotions this Character has actually recorded (for the honest badge). */
  available?: string[];
  /** The emotions offered. Defaults to whatever is already on the text plus the
   *  Character's own recorded slots. */
  scale?: string[];
  expr?: Expression;
  /** The emotion chip row (and its wheel button), rendered INSIDE this
   *  component's one direction panel. It is the console's node because the same
   *  row also serves script mode, where the selection it acts on lives on a
   *  different surface — but it belongs in this panel, beside the other things
   *  that act on a selection, rather than in a section of its own two borders
   *  further down the page. Absent → the panel simply starts at the placement
   *  row. */
  chips?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const { text, regions } = useMemo(() => parseTags(value), [value]);

  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [pending, setPending] = useState<string>("");
  const [showRaw, setShowRaw] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  const { preview, busy, stopPreview, playRegion } = useScorePreview({
    text, regions, characterId, expr, onNotice: setNotice,
  });

  const choices = useMemo(() => {
    // Whatever is offered must at least contain what is already ON the text, or
    // a region tagged with a custom emotion would be unselectable in its own
    // editor. FALLBACK_CHOICE keeps the control from ever rendering empty.
    const seen = new Set<string>([...(scale ?? []), ...available, ...regions.map((r) => r.value)]);
    seen.delete("baseline");
    if (seen.size === 0) seen.add(FALLBACK_CHOICE);
    return [...seen];
  }, [scale, available, regions]);

  const emotion = choices.includes(pending) ? pending : choices[0];

  const {
    suggestions, setSuggestions, directorNote, setDirectorNote, direct, take, dismissAll,
  } = useScoreDirector({
    value, text, regions, choices, onChange, onNotice: setNotice, onApplied: setApplied,
  });

  /** Emit a new score. The plain text is unchanged unless `nextText` says so. */
  const emit = (nextRegions: ScoreRegion[], nextText = text) =>
    onChange(toTags(nextText, nextRegions));

  // ── text edits ─────────────────────────────────────────────────────────────
  function editText(nextText: string) {
    const { next, message } = editPlainText(value, nextText);
    if (message) setSelected(null);
    setNotice(message);
    // Suggestions are offsets into the text that produced them. Rather than
    // carrying them across an edit — which would land a proposal the user never
    // saw on words it was not made for — the proposal is DROPPED and says so.
    // `transformRegions` exists for direction the user chose; a guess has not
    // earned that benefit of the doubt.
    if (suggestions.length > 0) {
      setSuggestions([]);
      setDirectorNote("Suggestions dropped — you changed the words they were made for. Direct the text again for a fresh pass.");
    }
    onChange(next);
  }

  // ── regions ────────────────────────────────────────────────────────────────
  /** Direct the current selection as `value` — or, for `baseline`, clear it.
   *  The single entry point for the "+ add region" button, the emotion chips and
   *  the wheel, so all three refuse for the same reasons in the same words. */
  function place(chosen: string) {
    const { next, message } = applyEmotion(value, sel.start, sel.end, chosen);
    setNotice(message);
    if (next === null) {
      // The refusal is already in the notice, which IS a live region. Clearing
      // this one keeps it from re-announcing a stale success on top of it.
      setApplied(null);
      return;
    }
    // A clearance names itself in the notice; only the ordinary success — the
    // one that used to be completely silent — needs saying here.
    setApplied(message ? null : wrappedAnnouncement(text, sel.start, sel.end, chosen));
    // A suggestion over words the user has now directed themselves is no longer
    // acceptable (the grammar cannot nest, so `applyEmotion` would refuse it)
    // and no longer wanted. Drop it silently — the user answered the question.
    const from = Math.min(sel.start, sel.end);
    const to = Math.max(sel.start, sel.end);
    setSuggestions((list) => list.filter((s) => !(s.start < to && from < s.end)));
    // Open the inspector on what was just placed. The index is read back off
    // the NEW string rather than guessed, because regions are always re-derived.
    const placed = parseTags(next).regions.findIndex((r) => r.start === from && r.value === chosen);
    setSelected(placed >= 0 ? placed : null);
    onChange(next);
  }

  useImperativeHandle(ref, () => ({ applyEmotion: place }));

  function addRegion() {
    place(emotion);
  }

  function resize(i: number, edge: "start" | "end", to: number) {
    const next = resizeRegions(text, regions, i, edge, to);
    if (!next) return;
    setNotice(null);
    emit(next);
  }

  function retag(i: number, nextValue: string) {
    const { regions: next, why } = retagRegions(text, regions, i, nextValue);
    if (why) {
      setNotice(why);
      return;
    }
    if (!next) return;
    setNotice(null);
    emit(next);
  }

  function remove(i: number) {
    const r = regions[i];
    if (!r) return;
    stopPreview();
    setSelected(null);
    setNotice(`Removed the ${emotionMeta(r.value).label} region — those words return to baseline.`);
    emit(regions.filter((_, j) => j !== i));
  }

  const active = selected !== null ? regions[selected] : undefined;

  return (
    <section aria-label="Score" className={`space-y-3 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          score · {regions.length} region{regions.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <span className="font-jetbrains text-[10px] text-white/40">
            {text.length} characters · direction is written back as [tags]
          </span>
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            aria-pressed={showRaw}
            className={`font-jetbrains rounded-full border px-2.5 py-0.5 text-[10px] transition ${showRaw ? "border-cyan-400/30 bg-cyan-400/5 text-cyan-200" : "border-white/12 text-white/50 hover:border-white/25 hover:text-white/75"}`}
          >
            markup
          </button>
        </div>
      </div>

      {/* The text as the axis — and as the READING. The direction is painted
          under the words themselves (ScoreText's mirror), so a paragraph that
          combines three emotions looks like one; the lane below is now the
          place you GRAB a span, not the only place you can see one.

          `showRaw` is the power-user escape hatch: the `[tags]` string is the
          contract and an author who thinks in it should be able to read it —
          read-only, because the caret must never sit inside markup again. */}
      <ScoreText
        text={text}
        regions={regions}
        suggestions={suggestions.map(asRegion)}
        selection={sel}
        onChangeText={editText}
        onSelectionChange={setSel}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmit?.(); }}
        disabled={disabled}
        label="Score text"
        placeholder="Type the line, select the words you want to direct, then add a region."
      />

      {/* The lane, immediately under the words and slimmed to a STRIP: this is
          a timeline attached to the text, not a section of its own. It used to
          sit below the director, the review list AND the placement row — three
          panels away from the words its offsets are counted in. Regions are
          placed proportionally over the character range, which is what makes
          them draggable at all. */}
      <ScoreLane
        text={text}
        regions={regions}
        available={available}
        selected={selected}
        previewIndex={preview?.index ?? null}
        disabled={disabled}
        onSelect={setSelected}
        onPreview={(i) => void playRegion(i)}
        onResize={resize}
      />

      <ScoreMarkup value={value} show={showRaw} />

      {/* THE DIRECTION PANEL — one container for one decision.
          This was three standalone pieces stacked down the page, each with its
          own heading and its own border: the chip row ("direct the selected
          words", which lived up in the console), the placement row ("direct
          selection as … + add region"), and the director ("direct this text").
          A user reading top to bottom met the word "direct" three times in
          three boxes and had to work out that they were one control. They are
          grouped here by WHAT THEY ACT ON — the selection first, the whole text
          second — with a single divider between the two, and nothing repeats a
          heading its container already carries. */}
      <div data-direction-panel className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3">
        {chips}

        {/* Everything that acts on THE SELECTION. The chips above are the fast
            path; this is the same operation with the emotion named explicitly,
            and the selection stated as a number so the accessible path and the
            pointer path are visibly the same thing. */}
        <ScorePlacement
          emotion={emotion}
          choices={choices}
          available={available}
          selection={sel}
          disabled={disabled}
          onPending={setPending}
          onAdd={addRegion}
        />

        {/* …and the one thing that acts on THE WHOLE TEXT, on its own line
            under a hairline rather than in a section of its own. */}
        <ScoreDirector
          text={text}
          suggestions={suggestions}
          directorNote={directorNote}
          choices={choices}
          available={available}
          disabled={disabled}
          onDirect={direct}
          onAcceptAll={() => take(suggestions.map((_, i) => i))}
          onDismissAll={dismissAll}
          onAccept={(i) => take([i])}
          onReject={(i) => setSuggestions((list) => rejectSuggestion(list, i))}
          onRetag={(i, next) => setSuggestions((list) => retagSuggestion(list, i, next))}
        />

        {/* The inspector — the numeric path M2 names as mandatory, and the place
            a region is retagged, previewed and deleted. A hairline and nothing
            else: it used to draw its own rounded box, and a box inside a box is
            the visual noise this consolidation exists to remove. */}
        {active && selected !== null && (
          <ScoreInspector
            region={active}
            index={selected}
            text={text}
            choices={choices}
            available={available}
            disabled={disabled}
            busy={busy}
            previewing={preview?.index === selected}
            onResize={resize}
            onRetag={retag}
            onRemove={remove}
            onTogglePreview={() => (preview?.index === selected ? stopPreview() : void playRegion(selected))}
          />
        )}
      </div>

      {/* One live region for every refusal, clearance and failure above. */}
      <p aria-live="polite" className="font-jetbrains min-h-[1rem] text-[11px] leading-relaxed text-amber-200/90">
        {notice}
      </p>
      {/* …and one for the case that WORKS. The notice is amber and advisory, so
          a confirmation does not belong in it; sighted users see the span light
          up, and this is the same event for everyone else. */}
      <p aria-live="polite" data-testid="score-applied" className="sr-only">{applied}</p>
    </section>
  );
}

// `spans()` used to live here and drove a SEPARATE reading line under the
// textarea — the same words a second time, highlighted, because the editing
// surface itself could not be. ScoreText's mirror paints the real one, so the
// duplicate is gone rather than kept in step with it.
