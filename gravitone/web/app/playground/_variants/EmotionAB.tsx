"use client";

// ── A/B: one line, two emotions, side by side ────────────────────────────────
//
// The rack's audition answers "what is this Character's range?". This answers
// the sharper question a buyer actually asks: *what does switching ONE emotion
// do to this exact line, and does the speaker survive the switch?*
//
// So the text is held still and rendered twice, once under each chosen emotion
// tag, and the two takes sit next to each other with their own play buttons.
// Everything that could make the comparison dishonest is reported rather than
// hidden:
//
//   * **Both sides may have resolved to the same Voice.** A Character that has
//     not recorded `angry` falls back (service/emotions.py::resolve), and two
//     tiles playing one recording under two labels is the exact overclaim this
//     product exists to argue against. The backend's per-segment report says
//     which Voice actually spoke, and the panel says it out loud.
//   * **A side that dropped to the browser voice proves nothing** about a
//     Gravitone Voice, and is labelled as such rather than counted as a take.
//   * **Backpressure is a wait, not a verdict.** A 429 keeps whatever already
//     rendered and offers the retry with the backend's own Retry-After.
//
// Transport: this panel does NOT own an audio element. It is handed the
// console's one player (`useAudioPlayer`), because two elements would let A and
// B overlap — and the overlap would ruin precisely the comparison being made.

import { useCallback, useRef, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { emotionMeta } from "@/lib/emotions";
import { useMounted } from "@/lib/useMounted";
import type { OutputFormat } from "@/lib/audioFormats";
import { EngineBusyError, isAbort, speak } from "./engine";
import { stripTags, type Expression, type Take } from "./shared";
import EmotionAbSide from "./EmotionAbSide";
import {
  AB_SIDES, emptySide, sameVoiceWarning, spokenVoice, taggedFor,
  type AbSide, type Side,
} from "./emotionCompare";

export { AB_SIDES, sameVoiceWarning, spokenVoice, taggedFor };
export type { AbSide };

export default function EmotionAB({
  characterId, characterName, scale, recorded, text, expr, format,
  playingId, paused, toggle, stop, onKeep,
}: {
  characterId: string;
  characterName: string;
  /** The Character's palette (base scale + its custom slots). */
  scale: string[];
  /** The emotions it has actually RECORDED — the rest fall back. */
  recorded: string[];
  text: string;
  expr: Expression;
  format: OutputFormat;
  playingId: string | null;
  paused: boolean;
  toggle: (t: Take) => void;
  stop: () => void;
  /** Promote both takes into the console's log (share / download / punch in).
   *  Optional — without it the pair stays an experiment, which is all it is. */
  onKeep?: (takes: Take[]) => void;
}) {
  const first = recorded[0] ?? scale[0] ?? "baseline";
  const second = recorded.find((e) => e !== first) ?? scale.find((e) => e !== first) ?? first;

  const [sides, setSides] = useState<Record<AbSide, Side>>({
    A: emptySide(first), B: emptySide(second),
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busySec, setBusySec] = useState<number | null>(null);
  const runRef = useRef<AbortController | null>(null);
  const mounted = useMounted();

  const plain = stripTags(text).trim();
  const takes = [sides.A.take, sides.B.take].filter((t): t is Take => !!t);
  const clash = sameVoiceWarning(sides.A.take, sides.B.take);

  const setSide = useCallback((side: AbSide, patch: Partial<Side>) => {
    if (!mounted.current) return;
    setSides((prev) => ({ ...prev, [side]: { ...prev[side], ...patch } }));
  }, [mounted]);

  const pick = useCallback((side: AbSide, emotion: string) => {
    // Changing an emotion discards THAT side's take: leaving it on screen under
    // a new label would attribute a recording to an emotion that did not speak
    // it. The other side is untouched, so swapping one variable is one click.
    stop();
    setSides((prev) => ({ ...prev, [side]: emptySide(emotion) }));
    setNotice(null);
  }, [stop]);

  const render = useCallback(async () => {
    // In-flight gate: the pair is two synthesis jobs, and a double click would
    // put four into a queue that answers 429 past its admission.
    if (runRef.current || !plain || !characterId) return;
    const ctrl = new AbortController();
    runRef.current = ctrl;
    setBusy(true);
    setNotice(null);
    setBusySec(null);
    stop();
    try {
      // SEQUENTIAL, on purpose. Two concurrent renders of the same line is the
      // fastest way to earn a 429 on a CPU-only box, and the second take is
      // worth nothing until the first exists anyway.
      for (const side of AB_SIDES) {
        const emotion = (side === "A" ? sides.A : sides.B).emotion;
        setSide(side, { state: "rendering", take: null, reason: undefined });
        try {
          const r = await speak(taggedFor(text, emotion), characterId, expr, ctrl.signal, format);
          if (!mounted.current || ctrl.signal.aborted) return;
          const take: Take = {
            id: `ab-${Date.now()}-${side}`,
            text: plain,
            characterId, characterName: `${characterName} · ${emotionMeta(emotion).label}`,
            mode: r.mode, fallbackReason: r.fallbackReason, fallbackDetail: r.fallbackDetail,
            url: r.url, blob: r.blob, peaks: r.peaks, seconds: r.seconds, kb: r.kb, rtf: r.rtf,
            synthSeconds: r.synthSeconds, queueSeconds: r.queueSeconds,
            ignoredSettings: r.ignoredSettings, segments: r.segments, expr: { ...expr },
            createdAt: Date.now(), format: r.format,
          };
          setSide(side, { state: "done", take });
        } catch (e) {
          if (!mounted.current) return;
          if (isAbort(e)) { setSide(side, { state: "idle" }); return; }
          if (e instanceof EngineBusyError) {
            // Not a failure of this side — the engine is up and told us when to
            // come back. Whatever already rendered stays on screen.
            setSide(side, { state: "idle" });
            setBusySec(e.retryAfterSec);
            setNotice(`The engine is at capacity — side ${side} was not rendered. `
              + `Retry in about ${e.retryAfterSec}s; anything already rendered is kept.`);
            return;
          }
          setSide(side, {
            state: "failed",
            reason: e instanceof Error && e.message ? e.message : "synthesis failed",
          });
        }
      }
    } finally {
      if (runRef.current === ctrl) runRef.current = null;
      if (mounted.current) setBusy(false);
    }
  }, [plain, characterId, characterName, text, expr, format, sides.A, sides.B,
      setSide, stop, mounted]);

  const cancel = useCallback(() => {
    runRef.current?.abort();
    runRef.current = null;
  }, []);

  return (
    <div className="glass-panel mt-4 rounded-2xl p-5">
      {/* One announcement for the pair. `aria-live` without `role="status"`:
          the same live-region mechanism, without adding a second status-role
          element to a console that already has exactly one. */}
      <p aria-live="polite" className="sr-only">
        {busy || takes.length < 2 ? "" :
          `A/B ready — ${emotionMeta(sides.A.emotion).label} and `
          + `${emotionMeta(sides.B.emotion).label}, same line, ready to compare.`}
      </p>
      <div className="font-jetbrains mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-widest text-white/60">
        <span>emotion a/b</span>
        <span className="normal-case tracking-normal text-white/45">
          same line · two emotions · one Character
        </span>
      </div>

      <p className="font-hanken max-w-2xl text-sm leading-relaxed text-white/65">
        Render <span className="text-white">this exact line</span> under two emotions and hear
        them back to back. The text never changes, so anything you hear is the difference
        between two <span className="text-white">recordings</span> — including whether{" "}
        {characterName || "the Character"} still sounds like themselves in both.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {AB_SIDES.map((side) => (
          <EmotionAbSide
            key={side}
            side={side}
            s={sides[side]}
            scale={scale}
            recorded={recorded}
            characterName={characterName}
            busy={busy}
            playingId={playingId}
            paused={paused}
            toggle={toggle}
            onPick={pick}
          />
        ))}
      </div>

      {/* The comparison invalidating itself, said before the user draws a
          conclusion from it. */}
      {clash && <ErrorBanner severity="warning" className="mt-3">{clash}</ErrorBanner>}
      {notice && <ErrorBanner severity="warning" className="mt-3">{notice}</ErrorBanner>}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => void render()}
          disabled={busy || !plain || !characterId}
          title={!plain ? "Write a line above first"
            : `Render it once as ${emotionMeta(sides.A.emotion).label} and once as ${emotionMeta(sides.B.emotion).label}.`}
          className="font-jetbrains cursor-pointer rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-1.5 text-[12px] text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
        >
          {busy ? "rendering A/B…" : "⇄ render both"}
        </button>
        {busy && (
          <button
            onClick={cancel}
            className="font-jetbrains rounded-full border border-white/15 px-3 py-1.5 text-[12px] text-white/70 transition hover:bg-white/5"
          >
            cancel
          </button>
        )}
        {busySec !== null && !busy && (
          <span className="font-jetbrains text-[11px] text-amber-300">
            backend asked for ~{busySec}s
          </span>
        )}
        {onKeep && takes.length === 2 && (
          <button
            onClick={() => onKeep(takes)}
            title="Copy both takes into the takes log, where they can be shared, downloaded or punched in."
            className="font-jetbrains rounded-full border border-white/15 px-3 py-1.5 text-[12px] text-white/70 transition hover:bg-white/5"
          >
            ↓ keep both in takes
          </button>
        )}
      </div>
    </div>
  );
}
