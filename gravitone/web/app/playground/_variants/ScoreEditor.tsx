"use client";

// The score — directing a performance as a visual act.
//
// The engine has accepted inline emotion spans since day one, but the only way
// to use them was to remember the `[excited]…[/excited]` syntax and type it into
// a textarea, which is why the most expressive capability in the product was
// invisible unless you read the API docs. Here the same string is a SCORE: the
// text is the horizontal axis, each directed span is an object beneath it
// tinted by its emotion's hue and badged with its sigil, and you place one by
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

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import EmotionArt from "@/components/ui/EmotionArt";
import Region from "@/components/ui/Region";
import Track from "@/components/ui/Track";
import { emotionMeta } from "@/lib/emotions";
import {
  applyEmotion, DEFAULT_EXPRESSION, editPlainText, parseTags, regionProblem, scoreRegion, toTags,
  type Expression, type ScoreRegion,
} from "./shared";

/** What the console can ask of the score from OUTSIDE it — the emotion chips
 *  and the wheel live up there, but the selection they act on lives down here.
 *  One method, so the picker paths and the "+ add region" button are literally
 *  the same operation (shared.applyEmotion). */
export type ScoreEditorHandle = { applyEmotion: (emotion: string) => void };

/** How the lane is drawn. Tall enough for a badge + a label, short enough that
 *  the score does not dominate the composer it hangs under. */
const LANE_HEIGHT = 40;

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

  const areaRef = useRef<HTMLTextAreaElement>(null);
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
    onChange(next);
  }

  function readSelection() {
    const el = areaRef.current;
    if (!el) return;
    setSel({ start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 });
  }

  // ── regions ────────────────────────────────────────────────────────────────
  /** Direct the current selection as `value` — or, for `baseline`, clear it.
   *  The single entry point for the "+ add region" button, the emotion chips and
   *  the wheel, so all three refuse for the same reasons in the same words. */
  function place(chosen: string) {
    const { next, message } = applyEmotion(value, sel.start, sel.end, chosen);
    setNotice(message);
    if (next === null) return;
    // Open the inspector on what was just placed. The index is read back off
    // the NEW string rather than guessed, because regions are always re-derived.
    const from = Math.min(sel.start, sel.end);
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
        <span className="font-jetbrains text-[10px] text-white/40">
          {text.length} characters · direction is written back as [tags]
        </span>
      </div>

      {/* The text as the axis: editable, and the same characters the offsets
          below are counted in. */}
      <textarea
        ref={areaRef}
        value={text}
        disabled={disabled}
        onChange={(e) => editText(e.target.value)}
        onSelect={readSelection}
        onKeyUp={readSelection}
        onMouseUp={readSelection}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmit?.(); }}
        rows={3}
        aria-label="Score text"
        placeholder="Type the line, select the words you want to direct, then add a region."
        className="font-hanken w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm leading-relaxed text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none disabled:opacity-50"
      />

      {/* The reading line — the text with its direction shown IN it. This is the
          part that makes the grammar visible without teaching it. */}
      {text.length > 0 && (
        <p className="font-hanken rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-sm leading-relaxed text-white/80">
          {spans(text, regions).map((s, i) =>
            s.value ? (
              <mark
                key={i}
                title={`${emotionMeta(s.value).label} — characters ${s.start} to ${s.end}`}
                className="rounded px-0.5 text-white"
                style={{ background: `hsl(${emotionMeta(s.value).hue} 82% 55% / 0.28)` }}
              >
                {text.slice(s.start, s.end)}
              </mark>
            ) : (
              <span key={i}>{text.slice(s.start, s.end)}</span>
            ),
          )}
        </p>
      )}

      {/* The lane. Regions are placed proportionally over the character range,
          which is what makes them draggable at all. */}
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
                badge={<EmotionArt emotion={r.value} size={14} dim={!available.includes(r.value)} />}
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
        <p className="font-jetbrains rounded-xl border border-dashed border-white/12 px-3 py-2 text-[11px] leading-relaxed text-white/50">
          No direction yet — this whole line is spoken in the Character&apos;s baseline Voice. Select
          words above and add a region to switch the Voice for just those words.
        </p>
      )}

      {/* Placement. The selection is stated as a number so the accessible path
          and the pointer path are visibly the same operation. */}
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

      {/* The inspector — the numeric path M2 names as mandatory, and the place a
          region is retagged, previewed and deleted. */}
      {active && selected !== null && (
        <div className="grid gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 sm:grid-cols-[auto_auto_auto_1fr]">
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

      {/* One live region for every refusal, clearance and failure above. */}
      <p aria-live="polite" className="font-jetbrains min-h-[1rem] text-[11px] leading-relaxed text-amber-200/90">
        {notice}
      </p>
    </section>
  );
}

/** The text broken into alternating undirected / directed runs, for the reading
 *  line. Pure, and derived from the same regions the lane draws. */
function spans(text: string, regions: ScoreRegion[]): Array<{ start: number; end: number; value?: string }> {
  const out: Array<{ start: number; end: number; value?: string }> = [];
  let at = 0;
  for (const r of regions) {
    if (r.start > at) out.push({ start: at, end: r.start });
    out.push({ start: r.start, end: r.end, value: r.value });
    at = r.end;
  }
  if (at < text.length) out.push({ start: at, end: text.length });
  return out;
}
