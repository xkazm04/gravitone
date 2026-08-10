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
import { emotionMeta } from "@/lib/emotions";
import { derivedDonorLabel, type Slot } from "@/app/voices/_data/characters";
import {
  auditionSummary, useEmotionAudition, type AuditionTarget,
} from "./audition";
import EmotionAuditionTile from "./EmotionAuditionTile";

export default function EmotionAudition({ name, slots }: {
  name: string;
  slots: Slot[];
}) {
  // Only slots with a Voice can be auditioned. An empty slot would simply
  // re-render the baseline take under another name — eight identical clips
  // presented as a range is the exact overclaim this feature is an argument
  // against — so it is named as missing instead.
  //
  // A DERIVED slot is auditioned (it is a real embedding making a real sound,
  // and hearing it is exactly how a user judges whether to keep it), but it
  // travels with its origin so no tile can pass a computed take off as a
  // performance — the line the rack holds one element above.
  const targets: AuditionTarget[] = slots
    .filter((s) => s.voice)
    .map((s) => ({
      emotion: s.emotion, label: s.label, voiceId: s.voice!.voice_id,
      derivedFrom: derivedDonorLabel(s.voice),
    }));
  const missing = slots.filter((s) => !s.voice);
  const derivedCount = targets.filter((t) => t.derivedFrom).length;

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

      {/* The identity claim is only as wide as the set it is made over. With a
          computed take in the matrix, "you hear that {name} is still {name} in
          all of it" is an overclaim — a derived voice is a real embedding
          making a real sound, but nobody performed it, so it can vouch for the
          algebra and never for the speaker. The claim narrows to the recordings
          instead of being dropped: that IS still the check the user came for. */}
      <p className="font-hanken max-w-2xl text-sm leading-relaxed text-white/65">
        Every Voice speaks the <span className="text-white">same line</span>. That is the
        experiment: the text is held still so the only thing that can differ between two
        takes is the {derivedCount > 0 ? "voice" : "recording"} behind them — you hear the
        range, and{" "}
        {derivedCount > 0 ? (
          <>
            across the <span className="text-white">recorded</span> takes you hear that{" "}
            {name} is still {name}. {derivedCount}{" "}
            {derivedCount === 1 ? "tile is" : "tiles are"}{" "}
            <span className="text-violet-200">derived</span> — computed from a baseline plus
            a borrowed emotion direction, not performed by {name} — so{" "}
            {derivedCount === 1 ? "it tells" : "they tell"} you what the algebra sounds
            like, never that {name} performed it.
          </>
        ) : (
          <>you hear that {name} is still {name} in all of it.</>
        )}{" "}
        Emotions here are auditioned, not prompted.
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
          title={`Render “${line.trim()}” once in each of ${name}'s ${targets.length} Voices.`
            + (derivedCount > 0 ? ` ${derivedCount} of them are derived, not recorded.` : "")}
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
        {targets.map((t) => (
          <EmotionAuditionTile
            key={t.emotion}
            target={t}
            cell={cells[t.emotion]}
            isPlaying={playing === t.emotion}
            name={name}
            onPlay={() => void play(t)}
          />
        ))}
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
