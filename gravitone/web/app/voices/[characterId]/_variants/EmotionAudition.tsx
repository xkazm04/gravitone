"use client";

// THE AUDITION MATRIX — the whole emotional range of one Character, on one
// line, in one action.
//
// This is the surface that makes Gravitone's emotion claim checkable rather
// than merely stated. Every tile speaks IDENTICAL text; the only thing that
// changes between them is which recorded Voice spoke it. So a listener can hear
// the range AND verify the speaker never drifted — two questions that a
// per-generation prompt lottery cannot answer at all, because there each render
// is a fresh roll.
//
// Nothing here invents backend surface: each tile renders through the same
// `/api/tts` proxy the rack's row-preview already uses, against the concrete
// voice id the row displays. What is new is the DISCIPLINE around it (bounded
// concurrency, waited-out backpressure, a per-tile outcome, a client-side
// cache) — all of which lives in ./audition.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import EmotionArt from "@/components/ui/EmotionArt";
import { emotionMeta } from "@/lib/emotions";
import type { Slot } from "@/app/voices/_data/characters";
import {
  auditionSummary, useEmotionAudition, type AuditionCell, type AuditionTarget,
} from "./audition";

/** What one tile says it is doing. Never a bare spinner: a state with no
 *  sentence is the shape this codebase calls a stuck spinner. */
function cellLine(cell: AuditionCell | undefined): { text: string; tone: string } {
  switch (cell?.kind) {
    case "queued":
      return { text: "queued", tone: "text-white/45" };
    case "rendering":
      return { text: "rendering…", tone: "text-cyan-300/80" };
    case "waiting":
      return {
        // The backend's own Retry-After, ticking. "The engine is full and told
        // us when to come back" is a different fact from "this failed", and the
        // user can act on exactly one of them (wait).
        text: `engine full — retrying in ${cell.seconds}s (${cell.attempt})`,
        tone: "text-amber-300",
      };
    case "ready":
      return cell.cached
        ? { text: "ready · cached", tone: "text-emerald-300/80" }
        : { text: "ready", tone: "text-emerald-300/80" };
    case "failed":
      return { text: cell.reason, tone: "text-rose-300" };
    default:
      return { text: "not auditioned", tone: "text-white/35" };
  }
}

export default function EmotionAudition({ name, slots }: {
  name: string;
  slots: Slot[];
}) {
  // Only slots with a Voice can be auditioned. An empty slot would simply
  // re-render the baseline take under another name — eight identical clips
  // presented as a range is the exact overclaim this feature is an argument
  // against — so it is named as missing instead.
  const targets: AuditionTarget[] = slots
    .filter((s) => s.voice)
    .map((s) => ({ emotion: s.emotion, label: s.label, voiceId: s.voice!.voice_id }));
  const missing = slots.filter((s) => !s.voice);

  const { line, editLine, cells, running, playing, playError,
          audition, stopRun, play } = useEmotionAudition(targets);
  const tally = auditionSummary(cells, targets.length);

  if (targets.length === 0) {
    return (
      <div className="glass-panel mt-4 rounded-xl p-4">
        <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          emotion audition
        </div>
        <p className="font-hanken mt-2 text-sm text-white/55">
          {name} has no recorded Voices yet. Record at least one slot above and the
          whole scale can be auditioned on one line.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-panel mt-4 rounded-xl p-4">
      {/* The run's one announcement. `aria-live` without `role="status"` on
          purpose: it is the same live-region mechanism, and it does not add a
          second element with the status role to a page that already has one. */}
      <p aria-live="polite" className="sr-only">
        {running
          ? ""
          : tally.ready + tally.failed > 0
            ? `Audition finished — ${tally.ready} of ${targets.length} voices rendered`
              + (tally.failed > 0 ? `, ${tally.failed} failed.` : ".")
            : ""}
      </p>
      <div className="font-jetbrains mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-widest text-white/60">
        <span>emotion audition</span>
        <span>
          {tally.ready}/{targets.length} rendered
          {tally.waiting > 0 && (
            <span className="ml-2 text-amber-300/80">· {tally.waiting} waiting on the queue</span>
          )}
          {tally.failed > 0 && (
            <span className="ml-2 text-rose-300/80">· {tally.failed} failed</span>
          )}
        </span>
      </div>

      <p className="font-hanken max-w-2xl text-sm leading-relaxed text-white/65">
        Every Voice speaks the <span className="text-white">same line</span>. That is the
        experiment: the text is held still so the only thing that can differ between two
        takes is the recording behind them — you hear the range, and you hear that {name} is
        still {name} in all of it. Emotions here are auditioned, not prompted.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          value={line}
          onChange={(e) => editLine(e.target.value)}
          aria-label="The line every emotion speaks"
          placeholder="the line every emotion speaks…"
          maxLength={300}
          className="font-hanken min-w-[18rem] flex-1 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-1.5 text-sm text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none"
        />
        <button
          onClick={() => void audition()}
          disabled={running || line.trim().length === 0}
          title={`Render “${line.trim()}” once in each of ${name}'s ${targets.length} recorded Voices.`}
          className="font-jetbrains cursor-pointer rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-1.5 text-[12px] text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
        >
          {running ? "auditioning…" : `▶ audition all ${targets.length}`}
        </button>
        {running && (
          <button
            onClick={stopRun}
            className="font-jetbrains rounded-full border border-white/15 px-3 py-1.5 text-[12px] text-white/70 transition hover:bg-white/5"
          >
            stop
          </button>
        )}
      </div>

      {/* A refused playback is not a failed render: the take exists and is still
          held, so it gets its own line rather than poisoning the tile. */}
      {playError && (
        <ErrorBanner severity="warning" className="mt-3">
          {emotionMeta(playError.emotion).label} could not be played — {playError.reason}
        </ErrorBanner>
      )}

      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
        {targets.map((t) => {
          const cell = cells[t.emotion];
          const status = cellLine(cell);
          const ready = cell?.kind === "ready";
          const isPlaying = playing === t.emotion;
          const hue = emotionMeta(t.emotion).hue;
          return (
            <div
              key={t.emotion}
              className={`rounded-lg border p-2.5 transition ${
                cell?.kind === "failed"
                  ? "border-rose-400/25 bg-rose-400/[0.04]"
                  : isPlaying
                    ? "border-cyan-400/40 bg-cyan-400/[0.06]"
                    : "border-white/8 bg-white/[0.02]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
                  <EmotionArt emotion={t.emotion} size={30} dim={!ready} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
                  {t.label}
                </span>
                <button
                  onClick={() => void play(t)}
                  disabled={!ready}
                  // Named for the AUDITION, not just the emotion: the rack row
                  // above has its own "Play Baseline", and two controls sharing
                  // one accessible name is a real ambiguity for anyone who
                  // navigates by name rather than by position.
                  aria-label={isPlaying
                    ? `Stop the auditioned ${t.label} take`
                    : `Play the auditioned ${t.label} take`}
                  title={ready ? `Play ${name}'s ${t.label} take of this line` : "Audition first"}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] text-slate-950 transition hover:brightness-110 disabled:opacity-25"
                  style={{ background: `hsl(${hue} 85% 64%)` }}
                >
                  {isPlaying ? "⏸" : "▶"}
                </button>
              </div>
              {/* Not a live region: eight tiles each announcing themselves
                  would shout over each other (and over the page's own status
                  region). The run gets ONE announcement, above. */}
              <p
                title={cell?.kind === "failed" ? cell.reason : undefined}
                className={`font-jetbrains mt-2 line-clamp-2 text-[11px] leading-relaxed ${status.tone}`}
              >
                {status.text}
              </p>
            </div>
          );
        })}
      </div>

      {missing.length > 0 && (
        <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/45">
          {missing.length} slot{missing.length === 1 ? "" : "s"} not recorded —{" "}
          {missing.map((s) => s.label).join(", ")}. They are left out of the audition on
          purpose: an unrecorded emotion falls back to another Voice, and playing that
          clip under its label would present the same take twice as a range.
        </p>
      )}
    </div>
  );
}
