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

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import EmotionIcon from "@/components/ui/EmotionIcon";
import Region from "@/components/ui/Region";
import Track from "@/components/ui/Track";
import { emotionMeta } from "@/lib/emotions";
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import ScoreText from "./ScoreText";
import {
  accept, asRegion, fallbackNote, proposalSummary, REASONS, reviewText,
  // Aliased: `retag` is already this component's word for re-aiming a PLACED
  // region, and the two must not be confused — one edits the string, the other
  // edits a proposal that is not in the string yet.
  reject as rejectSuggestion, retag as retagSuggestion,
  type Suggestion,
} from "./suggest";
import {
  applyEmotion, DEFAULT_EXPRESSION, editPlainText, parseTags, regionProblem, scoreRegion, toTags,
  wrappedAnnouncement, type Expression, type ScoreRegion,
} from "./shared";

/** What the console can ask of the score from OUTSIDE it — the emotion chips
 *  and the wheel live up there, but the selection they act on lives down here.
 *  One method, so the picker paths and the "+ add region" button are literally
 *  the same operation (shared.applyEmotion). */
export type ScoreEditorHandle = { applyEmotion: (emotion: string) => void };

/** How the lane is drawn. A STRIP attached to the text, not a section under it:
 *  40px with its own heading and its own empty-state box read as a second
 *  panel, and the composer's vertical stack was already three panels too long.
 *  28 is the floor a <Region> stays grabbable at (it insets 4px top and bottom,
 *  and its badge is 18). */
const LANE_HEIGHT = 28;

/** Offered when a Character reports no scale at all, so the placement control
 *  is never an empty dropdown next to an enabled button. */
const FALLBACK_CHOICE = "excited";

type PreviewState = { index: number; url: string } | null;

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
  const [preview, setPreview] = useState<PreviewState>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [pending, setPending] = useState<string>("");
  const [showRaw, setShowRaw] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  // The director's open proposal. Never part of `value` — a suggestion the user
  // has not accepted must not reach the engine, and this state is the whole
  // reason it cannot.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [directorNote, setDirectorNote] = useState<string | null>(null);
  const { copied, failed, copy } = useCopyFeedback();

  const railRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  // Object URLs and in-flight previews are ours to clean up: a score left open
  // while the console re-renders must not leak a WAV per click.
  useEffect(() => () => {
    abortRef.current?.abort();
    audioRef.current?.pause();
  }, []);
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

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

  // ── the director ───────────────────────────────────────────────────────────
  /** Propose spans over the current text. Synchronous and local — there is no
   *  request to gate, cancel or fail, because there is no model: see suggest.ts
   *  for why this is rules rather than the narrate endpoint the idea assumed. */
  function direct() {
    // `reviewText`, not `propose`: a list has one empty value and this pass has
    // THREE empty outcomes, which used to be reported with the one sentence
    // that happened to be wrong for the default text. The note below always
    // changes, so the click always has a visible answer.
    const outcome = reviewText(text, choices, regions);
    setSuggestions(outcome.suggestions);
    setDirectorNote(proposalSummary(outcome));
    setNotice(null);
  }

  /** Accept some of the proposal. One fold through `applyEmotion`, so an
   *  accepted suggestion is exactly a hand-placed region — and a refusal is
   *  reported in the composer's own words rather than counted as a success. */
  function take(indexes: number[]) {
    const result = accept(value, suggestions, indexes);
    const survivors = suggestions.filter(
      (s, i) => !indexes.includes(i) || result.refused.some((r) => r.suggestion === s),
    );
    setSuggestions(survivors);
    if (result.applied > 0) {
      onChange(result.next);
      setApplied(`Accepted ${result.applied} suggestion${result.applied === 1 ? "" : "s"}.`);
    }
    setNotice(result.refused[0]?.why ?? null);
    setDirectorNote(
      survivors.length > 0
        ? `${survivors.length} suggestion${survivors.length === 1 ? "" : "s"} left to review.`
        : null,
    );
  }

  function dismissAll() {
    setSuggestions([]);
    setDirectorNote("Suggestions dismissed — nothing was changed.");
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
    const r = regions[i];
    if (!r) return;
    const floor = i > 0 ? regions[i - 1].end : 0;
    const ceil = i < regions.length - 1 ? regions[i + 1].start : text.length;
    const next =
      edge === "start"
        ? scoreRegion(Math.max(floor, Math.min(to, r.end - 1)), r.end, r.value)
        : scoreRegion(r.start, Math.min(ceil, Math.max(to, r.start + 1)), r.value);
    if (next.start === r.start && next.end === r.end) return;
    setNotice(null);
    emit(regions.map((x, j) => (j === i ? next : x)));
  }

  function retag(i: number, nextValue: string) {
    const r = regions[i];
    if (!r) return;
    const why = regionProblem(text, scoreRegion(r.start, r.end, nextValue), regions.filter((_, j) => j !== i));
    if (why) {
      setNotice(why);
      return;
    }
    setNotice(null);
    emit(regions.map((x, j) => (j === i ? scoreRegion(x.start, x.end, nextValue) : x)));
  }

  function remove(i: number) {
    const r = regions[i];
    if (!r) return;
    stopPreview();
    setSelected(null);
    setNotice(`Removed the ${emotionMeta(r.value).label} region — those words return to baseline.`);
    emit(regions.filter((_, j) => j !== i));
  }

  // ── solo preview ───────────────────────────────────────────────────────────
  function stopPreview() {
    abortRef.current?.abort();
    abortRef.current = null;
    audioRef.current?.pause();
    setPreview(null); // the effect above revokes the object URL

    setBusy(false);
  }

  /**
   * Hear ONE region. Deliberately a small local request rather than the
   * console's engine: this asks for the span alone, with its own tag around it,
   * so what plays is what that direction sounds like — not the take it sits in.
   * A failure is reported as a sentence; nothing about the score changes.
   */
  async function playRegion(i: number) {
    const r = regions[i];
    if (!r) return;
    if (!characterId) {
      setNotice("Pick a Character above to hear a region on its own.");
      return;
    }
    stopPreview();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          character_id: characterId,
          text: `[${r.value}]${text.slice(r.start, r.end)}[/${r.value}]`,
          voice_settings: { temperature: expr.temperature, stability: expr.stability, quality: expr.quality },
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = ((await res.json()) as { detail?: string }).detail ?? "";
        } catch { /* a non-JSON error body tells us nothing extra */ }
        setNotice(`Could not preview that region${detail ? ` — ${detail}` : ` (the engine answered ${res.status})`}.`);
        setBusy(false);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      if (ac.signal.aborted) {
        URL.revokeObjectURL(url);
        return;
      }
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.src = url;
      audio.onended = () => setPreview(null);
      setPreview({ index: i, url });
      setNotice(null);
      try {
        await audio.play();
      } catch {
        setNotice("Your browser refused to start playback — press play again after interacting with the page.");
        setPreview(null);
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        setNotice("Could not reach the engine to preview that region.");
      }
    } finally {
      setBusy(false);
    }
  }

  /** Rail x -> character offset, so a drag and an arrow key move the same edge
   *  through the same coordinate space. */
  const offsetAt = (clientX: number): number => {
    const box = railRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return Math.round(f * text.length);
  };

  const active = selected !== null ? regions[selected] : undefined;
  const selLen = Math.abs(sel.end - sel.start);

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
                  previewing={preview?.index === i}
                  disabled={disabled}
                  badge={<EmotionIcon emotion={r.value} size={16} dim={!available.includes(r.value)} />}
                  onSelect={() => setSelected(i)}
                  onPreview={() => void playRegion(i)}
                  onResize={(edge, to) => resize(i, edge, to)}
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

      {showRaw && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-jetbrains text-[10px] uppercase tracking-widest text-white/45">
              what the engine receives
            </span>
            <button
              type="button"
              onClick={() => void copy(value)}
              className="font-jetbrains rounded-full border border-white/15 px-2.5 py-0.5 text-[10px] text-white/60 transition hover:border-cyan-400/40 hover:text-cyan-200"
            >
              {failed ? "copy blocked" : copied ? "✓ copied" : "copy"}
            </button>
          </div>
          <pre className="font-jetbrains overflow-x-auto rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-cyan-100/80">
            {value || "(empty)"}
          </pre>
        </div>
      )}

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
        <div className="flex flex-wrap items-center gap-2">
          <label className="font-jetbrains text-[11px] text-white/55" htmlFor="score-emotion">
            direct selection as
          </label>
          <select
            id="score-emotion"
            value={emotion}
            disabled={disabled}
            onChange={(e) => setPending(e.target.value)}
            className="font-jetbrains rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
          >
            {choices.map((id) => (
              <option key={id} value={id} className="bg-slate-900 text-white">
                {emotionMeta(id).label}
                {available.length > 0 && !available.includes(id) ? " (not recorded)" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addRegion}
            disabled={disabled}
            className="font-jetbrains rounded-full border border-cyan-400/30 bg-cyan-400/5 px-3 py-1 text-[11px] text-cyan-200 transition enabled:hover:bg-cyan-400/10 disabled:opacity-40"
          >
            + add region
          </button>
          <span className="font-jetbrains text-[10px] text-white/40">
            {selLen > 0
              ? `${selLen} character${selLen === 1 ? "" : "s"} selected (${Math.min(sel.start, sel.end)}–${Math.max(sel.start, sel.end)})`
              : "select words in the text above"}
          </span>
        </div>

        {/* …and the one thing that acts on THE WHOLE TEXT, on its own line
            under a hairline rather than in a section of its own. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-white/8 pt-3">
          <button
            type="button"
            onClick={direct}
            disabled={disabled || text.trim().length === 0}
            className="font-jetbrains rounded-full border border-violet-400/30 bg-violet-400/5 px-3 py-1 text-[11px] text-violet-200 transition enabled:hover:bg-violet-400/10 disabled:opacity-40"
          >
            ✎ direct this text
          </button>
          {suggestions.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => take(suggestions.map((_, i) => i))}
                disabled={disabled}
                className="font-jetbrains rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/75 transition enabled:hover:border-emerald-400/40 enabled:hover:text-emerald-200 disabled:opacity-40"
              >
                accept all
              </button>
              <button
                type="button"
                onClick={dismissAll}
                className="font-jetbrains rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/60 transition hover:border-white/30 hover:text-white/80"
              >
                dismiss all
              </button>
            </>
          )}
        </div>

        {/* The ANSWER to the button — its own block, at reading size.
            This was a 10px `text-white/50` span wedged into the button row, so
            the one outcome a first-time user always got (the shipped default text
            has exactly one cue, and it is already directed) looked identical to
            having pressed nothing. An action whose only response is invisible is
            an action that "does not do anything". */}
        {directorNote && (
          <p
            aria-live="polite"
            data-testid="director-note"
            className="font-hanken rounded-xl border border-violet-300/25 bg-violet-400/[0.06] px-3 py-2 text-[12px] leading-relaxed text-violet-100/90"
          >
            {directorNote}
          </p>
        )}

        {/* The review. Every row states the RULE that produced it, because the
            rule is the whole explanation — this pass reads punctuation, capitals
            and brackets, and a user who is shown that can forgive a weak call.
            A confident, unexplained guess is the thing to avoid: it would be
            claiming a comprehension nothing here has. */}
        {suggestions.length > 0 && (
          <ul className="space-y-1.5 rounded-xl border border-dashed border-violet-300/25 bg-violet-400/[0.03] px-3 py-2">
            {suggestions.map((s, i) => {
              const m = emotionMeta(s.value);
              const note = fallbackNote(s.value, available);
              return (
                <li key={`${s.start}-${s.reason}`} className="flex flex-wrap items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed"
                    style={{ borderColor: `hsl(${m.hue} 88% 68%)`, background: `hsl(${m.hue} 82% 55% / 0.2)` }}
                  />
                  <span className="font-hanken min-w-0 flex-1 truncate text-[12px] text-white/80">
                    &ldquo;{text.slice(s.start, s.end)}&rdquo;
                  </span>
                  <select
                    value={s.value}
                    disabled={disabled}
                    onChange={(e) => setSuggestions((list) => retagSuggestion(list, i, e.target.value))}
                    aria-label={`Emotion for the suggestion at characters ${s.start} to ${s.end}`}
                    className="font-jetbrains rounded-lg border border-white/15 bg-black/40 px-2 py-0.5 text-[11px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
                  >
                    {[...new Set([s.value, ...choices])].map((id) => (
                      <option key={id} value={id} className="bg-slate-900 text-white">{emotionMeta(id).label}</option>
                    ))}
                  </select>
                  <span className="font-jetbrains text-[10px] text-white/45">{REASONS[s.reason]}</span>
                  <button
                    type="button"
                    onClick={() => take([i])}
                    disabled={disabled}
                    aria-label={`Accept ${m.label} for "${text.slice(s.start, s.end)}"`}
                    className="font-jetbrains rounded-full border border-white/15 px-2.5 py-0.5 text-[11px] text-white/75 transition enabled:hover:border-emerald-400/40 enabled:hover:text-emerald-200 disabled:opacity-40"
                  >
                    accept
                  </button>
                  <button
                    type="button"
                    onClick={() => setSuggestions((list) => rejectSuggestion(list, i))}
                    aria-label={`Reject ${m.label} for "${text.slice(s.start, s.end)}"`}
                    className="font-jetbrains rounded-full border border-white/15 px-2.5 py-0.5 text-[11px] text-white/55 transition hover:border-rose-400/40 hover:text-rose-200"
                  >
                    reject
                  </button>
                  {note && <span className="font-jetbrains w-full text-[10px] text-amber-200/80">{note}</span>}
                </li>
              );
            })}
          </ul>
        )}

        {/* The inspector — the numeric path M2 names as mandatory, and the place
            a region is retagged, previewed and deleted. A hairline and nothing
            else: it used to draw its own rounded box, and a box inside a box is
            the visual noise this consolidation exists to remove. */}
        {active && selected !== null && (
          <div className="grid gap-2 border-t border-white/8 pt-3 sm:grid-cols-[auto_auto_auto_1fr]">
            <label className="font-jetbrains flex items-center gap-1.5 text-[11px] text-white/55">
              from
              <input
                type="number"
                min={0}
                max={active.end - 1}
                value={active.start}
                disabled={disabled}
                onChange={(e) => resize(selected, "start", Number(e.target.value))}
                aria-label="Region start, character offset"
                className="font-jetbrains w-16 rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
              />
            </label>
            <label className="font-jetbrains flex items-center gap-1.5 text-[11px] text-white/55">
              to
              <input
                type="number"
                min={active.start + 1}
                max={text.length}
                value={active.end}
                disabled={disabled}
                onChange={(e) => resize(selected, "end", Number(e.target.value))}
                aria-label="Region end, character offset"
                className="font-jetbrains w-16 rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
              />
            </label>
            <select
              value={active.value}
              disabled={disabled}
              onChange={(e) => retag(selected, e.target.value)}
              aria-label="Region emotion"
              className="font-jetbrains rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
            >
              {[...new Set([active.value, ...choices])].map((id) => (
                <option key={id} value={id} className="bg-slate-900 text-white">
                  {emotionMeta(id).label}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => (preview?.index === selected ? stopPreview() : void playRegion(selected))}
                disabled={disabled || busy}
                className="font-jetbrains rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/75 transition enabled:hover:border-cyan-400/40 enabled:hover:text-cyan-200 disabled:opacity-40"
              >
                {busy ? "rendering…" : preview?.index === selected ? "stop" : "hear this region"}
              </button>
              <button
                type="button"
                onClick={() => remove(selected)}
                disabled={disabled}
                className="font-jetbrains rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/60 transition enabled:hover:border-rose-400/40 enabled:hover:text-rose-200 disabled:opacity-40"
              >
                delete
              </button>
            </div>
            <p className="font-jetbrains text-[10px] text-white/40 sm:col-span-4">
              {available.length > 0 && !available.includes(active.value)
                ? `${emotionMeta(active.value).label} is not recorded for this Character — the nearest recorded emotion is used, then baseline.`
                : "Drag an edge, nudge it with the arrow keys, or type an offset. Shift+arrow moves five characters."}
            </p>
          </div>
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
