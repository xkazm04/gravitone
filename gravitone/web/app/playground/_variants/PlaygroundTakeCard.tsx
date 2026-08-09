"use client";

// ONE TAKE, AS A ROW — transport, waveform, the numbers the render actually
// measured, every verb the take offers, and the drill-downs (code, timeline)
// that stay collapsed until asked for.
//
// The playhead never reaches this component as a prop: it arrives through
// LiveProgress, which subscribes for the ONE row that is playing. Lifting that
// subscription up here (or into the log) would put a 4Hz tick through every
// AnimatePresence `layout` child on screen — the exact bug LiveProgress exists
// to prevent.

import Link from "next/link";
import { motion } from "framer-motion";
import { EASE } from "@/components/ui/tokens";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import { formatMeta } from "@/lib/audioFormats";
import { readEdits, type Take } from "./shared";
import { Bars, LiveProgress } from "./PlaygroundPrimitives";
import { TakeArrival } from "./signal";
import TakeCode from "./TakeCode";
// Punch-in: the take log's editing drill-down. Deliberately a separate module —
// the take card stays exactly what it was until the user asks for the timeline.
import PunchIn, { type CommitPayload } from "./PunchIn";
import type { ProgressSource } from "./useAudioPlayer";
import type { Character } from "@/app/voices/_data/characters";

/** Everything a card needs that is the SAME for every card in the log. Split
 *  out so the log can accept one object and spread it, instead of restating
 *  twenty props it only passes through. */
export type PlaygroundTakeCardShared = {
  characters: Character[];
  charName: (id: string) => string;
  still: boolean;
  playingId: string | null;
  paused: boolean;
  playhead: ProgressSource;
  toggle: (t: Take) => void;
  stop: () => void;
  seekTo: (t: Take, seconds: number) => unknown;
  reviewSel: Set<string>;
  setReviewSel: (updater: (s: Set<string>) => Set<string>) => void;
  shares: Record<string, string | "pending" | "error">;
  copied: string | null;
  copyFailed: string | null;
  onShare: (t: Take) => void;
  onReuse: (t: Take) => void;
  punchFor: string | null;
  setPunchFor: (updater: (p: string | null) => string | null) => void;
  codeFor: string | null;
  setCodeFor: (updater: (c: string | null) => string | null) => void;
  onRemove: (id: string) => void;
  onCommitPunch: (base: Take, p: CommitPayload) => void;
  onStorageError: (message: string | null) => void;
  engineBusy: boolean;
};

export function PlaygroundTakeCard({
  take: t, newest, characters, charName, still,
  playingId, paused, playhead, toggle, stop, seekTo,
  reviewSel, setReviewSel, shares, copied, copyFailed, onShare, onReuse,
  punchFor, setPunchFor, codeFor, setCodeFor, onRemove,
  onCommitPunch, onStorageError, engineBusy,
}: PlaygroundTakeCardShared & { take: Take; newest: boolean }) {
  const isCurrent = playingId === t.id;
  // Punch-in provenance. Absent on every take that was rendered in one
  // call, and on every record stored before the editor existed.
  const edits = readEdits(t);
  return (
    <motion.div layout initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }} className="glass-panel relative mb-2 rounded-xl px-5 py-4">
      {newest && <TakeArrival still={still} />}
      <div className="flex items-center gap-3">
        {/* compare selector — 2+ takes become a client review link */}
        <input
          type="checkbox"
          checked={reviewSel.has(t.id)}
          disabled={t.mode === "browser" || formatMeta(t.format).ext !== "wav"}
          onChange={(e) =>
            setReviewSel((s) => {
              const n = new Set(s);
              if (e.target.checked) { if (n.size < 6) n.add(t.id); } else n.delete(t.id);
              return n;
            })
          }
          title={t.mode === "browser" ? "Browser-fallback take — cannot be reviewed"
            : formatMeta(t.format).ext !== "wav"
              ? "Review links host wav takes — re-render this take as wav to include it"
              : "Select for a client review link (max 6)"}
          aria-label="Select take for client review"
          className="h-4 w-4 shrink-0 accent-cyan-300 disabled:opacity-30"
        />
        <button onClick={() => toggle(t)} aria-label={isCurrent && !paused ? "Pause" : "Play"}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-cyan-300 text-slate-950 transition hover:brightness-110">
          {isCurrent && !paused ? "⏸" : "▶"}
        </button>
        <button onClick={stop} disabled={!isCurrent} aria-label="Stop"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/15 text-white/70 transition enabled:hover:bg-white/5 disabled:opacity-25">■</button>

        {/* At the PLAY BUTTON, not only in a banner. A banner reports
            the last render; this log outlives it, and a take a judge
            presses ▶ on ten minutes later must still say what it is.
            Everything else browser-mode does here is a DISABLED
            control with a tooltip — invisible to anyone who does not
            go hunting, and absent entirely on touch. */}
        {t.mode === "browser" && (
          <span
            title="Rendered by your browser's built-in speech synthesis because Gravitone could not be reached — this is not the model's output"
            className="font-jetbrains shrink-0 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-200"
          >
            browser speech · not Gravitone
          </span>
        )}

        <LiveProgress source={playhead} active={isCurrent}>
          {(at) => <Bars peaks={t.peaks} progress={at} active={isCurrent} className="h-9 min-w-0 flex-1" />}
        </LiveProgress>

        <div className="font-jetbrains hidden shrink-0 items-center gap-4 text-[11px] text-white/65 sm:flex">
          <span className="text-white/80">{t.characterName}</span>
          <span>{t.seconds}s</span>
          {t.synthSeconds > 0 && <span title="server-side synthesis time">{t.synthSeconds}s synth</span>}
          {t.queueSeconds > 0 && <span title="time spent waiting in the render queue">{t.queueSeconds}s queue</span>}
          {t.rtf > 0 && <span className="text-cyan-300">{t.rtf}× rt</span>}
          {t.kb > 0 && <span>{t.kb} kb</span>}
        </div>

        <button
          onClick={() => void onShare(t)}
          disabled={t.mode === "browser" || shares[t.id] === "pending" || formatMeta(t.format).ext !== "wav"}
          title={t.mode === "browser" ? "Browser-speech fallback — nothing to share"
            : formatMeta(t.format).ext !== "wav"
              ? "Voice Cards are published as wav — re-render this take as wav to share it at a /t/… link"
              : "Publish this take at a public /t/… link (copies the URL)"}
          className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/80 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-white/50"
        >
          {shares[t.id] === "pending" ? "sharing…"
            : shares[t.id] === "error" ? "✗ failed"
            : shares[t.id] && copyFailed === t.id ? "published — copy failed"
            : shares[t.id] && copied === t.id ? "✓ link copied"
            : shares[t.id] ? "↗ copy link"
            : "↗ share"}
        </button>
        <button
          onClick={() => onReuse(t)}
          title="Load this take's text, Character and expression back into the composer"
          className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/80 transition hover:border-cyan-400/40 hover:text-cyan-200"
        >
          ↺ reuse
        </button>
        {/* The editor's entry point. Collapsed by default — the card
            is a log row until the user asks to edit it. */}
        <button
          onClick={() => setPunchFor((p) => (p === t.id ? null : t.id))}
          disabled={t.mode === "browser" || !t.blob}
          title={t.mode === "browser" || !t.blob
            ? "Browser-speech fallback take — there is no audio to edit"
            : "Show the segment timeline: hear a region, retake just that region"}
          aria-expanded={punchFor === t.id}
          className={`font-jetbrains shrink-0 rounded-lg border px-3 py-1.5 text-[11px] transition ${
            punchFor === t.id
              ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
              : "border-white/15 text-white/80 hover:bg-white/5 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-white/50"
          }`}
        >
          ⌗ timeline
        </button>
        <button
          onClick={() => setCodeFor((c) => (c === t.id ? null : t.id))}
          disabled={t.mode === "browser"}
          title={t.mode === "browser" ? "Browser-speech fallback take — no API request to export" : "Get this exact take as an API call"}
          aria-expanded={codeFor === t.id}
          className={`font-jetbrains shrink-0 rounded-lg border px-3 py-1.5 text-[11px] transition ${
            codeFor === t.id
              ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
              : "border-white/15 text-white/80 hover:bg-white/5 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-white/50"
          }`}
        >
          {"</>"} code
        </button>
        {t.url ? (
          <a href={t.url} download={`gravitone-${t.characterId}-${t.id}.${formatMeta(t.format).ext}`}
            title={`Download this take as ${formatMeta(t.format).ext}`}
            className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/80 transition hover:bg-white/5">↓ {formatMeta(t.format).ext}</a>
        ) : (
          <span title="Connect a Gravitone endpoint to export audio"
            className="font-jetbrains shrink-0 cursor-not-allowed rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-white/50">↓ {formatMeta(t.format).ext}</span>
        )}
        <button
          onClick={() => onRemove(t.id)}
          title="Delete this take from the log"
          aria-label="Delete take"
          className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/60 transition hover:border-rose-400/40 hover:text-rose-200"
        >
          ✕
        </button>
      </div>

      {codeFor === t.id && t.mode === "gravitone" && <TakeCode take={t} />}

      {/* Punch-in drill-down: the segment timeline plus the retake
          lanes for whichever region is selected. */}
      {punchFor === t.id && (
        <LiveProgress source={playhead} active={isCurrent}>
          {(at) => (
            <PunchIn
              take={t}
              characters={characters}
              charName={charName}
              playing={isCurrent}
              progress={at}
              onSeek={(seconds) => { void seekTo(t, seconds); }}
              onCommit={(p) => onCommitPunch(t, p)}
              onStorageError={onStorageError}
              engineBusy={engineBusy}
            />
          )}
        </LiveProgress>
      )}

      {/* segment ribbon — what actually ran */}
      {t.segments.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {t.segments.map((s, i) => {
            const m = emotionMeta(s.used);
            // Performance segments carry who spoke; solo takes don't.
            const segCharId = s.characterId ?? t.characterId;
            const segCharName = s.characterId ? charName(s.characterId) : null;
            return (
              <span key={i} title={s.text}
                className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/70">
                {segCharName && <span className="text-white/80">{segCharName}</span>}
                {segCharName && <span className="text-white/30">·</span>}
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${m.hue} 80% 62%)` }} />
                {s.fallback ? (
                  <><span className="text-amber-300/80 line-through">{s.requested}</span><span className="text-white/55">→</span><span>{s.used}</span></>
                ) : (
                  <span>{s.used}</span>
                )}
                <span className="text-white/55">{s.seconds}s</span>
                {/* fallback chips upsell the guided recorder */}
                {s.fallback && EMOTION_IDS.includes(s.requested) && (
                  <Link
                    href={`/voices/${encodeURIComponent(segCharId)}?record=${s.requested}`}
                    title={`${segCharName ?? t.characterName} has no ${s.requested} voice — record it and re-render this take`}
                    className="text-amber-300/90 underline-offset-2 transition hover:text-amber-200 hover:underline"
                  >
                    record →
                  </Link>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* This take is an EDIT of another one. Said out loud, because
          its one-line preview below is the base take's transcript —
          the exact text the base call still reproduces — while its
          audio has these regions replaced (the timeline shows them). */}
      {edits && edits.regions.length > 0 && (
        <p className="font-jetbrains mt-3 inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-cyan-400/20 bg-cyan-400/5 px-2.5 py-1 text-[11px] text-cyan-200/85">
          <span aria-hidden>✎</span>
          punched · segment{edits.regions.length === 1 ? "" : "s"}{" "}
          {edits.regions.map((r) => r.i + 1).join(", ")} re-rendered and spliced
          <span className="text-white/40">·</span>
          <span className="text-white/55">base {edits.source}</span>
        </p>
      )}

      {/* The engine DID report its segments and this build could not
          read the header. Without this, that take draws exactly like
          a one-segment take: no ribbon, no rail, no substitution
          notice — and nothing on screen to say the difference. The
          audio is untouched and correct; only the report is lost. */}
      {t.reportCorrupt && (
        <p className="font-jetbrains mt-3 inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-1 text-[11px] text-amber-200/85">
          <span aria-hidden>⚠</span>
          the engine&apos;s per-segment report could not be read — the audio is complete,
          but this take&apos;s emotion breakdown is missing (it is not a single-segment take).
        </p>
      )}

      {t.ignoredSettings.length > 0 && (
        <p className="font-jetbrains mt-3 inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-1 text-[11px] text-amber-200/85">
          <span aria-hidden>⚠</span>
          {t.ignoredSettings.join(", ")} ignored — not a Pocket TTS knob.
        </p>
      )}

      <p className="mt-2 line-clamp-1 text-sm text-white/65">{t.text}</p>
    </motion.div>
  );
}
