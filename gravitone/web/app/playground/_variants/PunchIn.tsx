"use client";

// PUNCH-IN — the take log's first editing surface.
//
// A take used to be immutable: disagree with one word in a 40-line performance
// and you paid for the whole render again. Everything needed to fix just that
// word is already on the card — the per-segment report says what each region
// says, which emotion ran and how long it took — so this panel adds the three
// missing verbs:
//
//   1. SEE   the take as regions (TakeTimeline), and hear one by clicking it.
//   2. RETAKE one region through /api/speak with its own emotion / Character /
//            expression, up to three lanes so you can audition rather than
//            gamble, each lane persisted (variantStore) so a refresh mid-
//            audition does not cost a CPU render.
//   3. COMMIT one lane: the splice kernel (engine.spliceRegion) cuts at the
//            segment edge, crossfades the seam and masters a new WAV take whose
//            provenance (shared.TakeEdits) says exactly how it was made.
//
// It is a DRILL-DOWN on purpose. The take card stays what it was until the user
// asks for the timeline, and a full re-render from the composer is always the
// escape hatch — a splice is a repair, not a replacement for directing the line
// again.

import { emotionMeta } from "@/lib/emotions";
import type { Character } from "@/app/voices/_data/characters";
import TakeTimeline from "./TakeTimeline";
import PunchLanes from "./PunchLanes";
import { usePunchSession } from "./usePunchSession";
import { type Take } from "./shared";
import { LANES, MAX_LANES_PER_REGION } from "./variantStore";
import type { CommitPayload } from "./punchTypes";

export type { CommitPayload };

export default function PunchIn({
  take,
  characters,
  charName,
  playing,
  progress,
  onSeek,
  onCommit,
  onStorageError,
  engineBusy,
}: {
  take: Take;
  characters: Character[];
  charName: (id: string) => string;
  playing: boolean;
  progress: number;
  onSeek: (seconds: number) => void;
  onCommit: (p: CommitPayload) => void;
  onStorageError: (message: string | null) => void;
  /** The composer is rendering. Two renders on a CPU-only box compete for the
   *  same pool, and the console already models that. */
  engineBusy: boolean;
}) {
  const {
    regions, selected, region, lane, scale,
    text, setText, emotion, setEmotion, charId, setCharId,
    variants, rendering, committing, err,
    pick, renderVariant, discard, commit, close,
  } = usePunchSession({ take, characters, charName, onSeek, onCommit, onStorageError });

  if (regions.length === 0) {
    return (
      <p className="font-jetbrains mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-white/55">
        This take carries no segment report, so there are no regions to punch. Re-render it with a Gravitone
        backend reachable and the timeline appears with it.
      </p>
    );
  }

  return (
    <div className="mt-1">
      <TakeTimeline
        take={take}
        regions={regions}
        selected={selected}
        onPick={pick}
        progress={progress}
        playing={playing}
        characterName={charName}
      />

      {region && (
        <div className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.03] p-3">
          <div className="font-jetbrains mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-widest text-white/60">
            <span>
              retake segment {region.index + 1}
              <span className="ml-2 normal-case tracking-normal text-white/45">
                {Math.round(region.start * 10) / 10}s → {Math.round(region.end * 10) / 10}s · boundaries snap to the
                segment edge
              </span>
            </span>
            <button
              onClick={close}
              className="cursor-pointer normal-case tracking-normal text-white/50 transition hover:text-white/80"
            >
              close
            </button>
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            aria-label={`Text for segment ${region.index + 1}`}
            placeholder="What this region should say…"
            className="font-hanken w-full resize-none rounded-lg border border-white/12 bg-black/30 px-3 py-2 text-sm leading-relaxed text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none"
          />

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="font-jetbrains text-[10px] uppercase tracking-widest text-white/45">emotion</span>
            <button
              onClick={() => setEmotion(null)}
              aria-pressed={emotion === null}
              title="Render this region exactly as the take renders it"
              className={`font-jetbrains cursor-pointer rounded-full border px-2 py-0.5 text-[10px] transition ${
                emotion === null ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/55 hover:text-white/85"
              }`}
            >
              as written
            </button>
            {scale.map((id) => {
              const m = emotionMeta(id);
              const on = emotion === id;
              return (
                <button
                  key={id}
                  onClick={() => setEmotion(id)}
                  aria-pressed={on}
                  title={`Wrap this region in [${id}] — a missing emotion uses the nearest recorded one`}
                  className="font-jetbrains cursor-pointer rounded-full border px-2 py-0.5 text-[10px] transition"
                  style={{
                    borderColor: `hsl(${m.hue} 80% 62% / ${on ? 0.7 : 0.25})`,
                    background: on ? `hsl(${m.hue} 80% 62% / 0.14)` : "transparent",
                    color: on ? `hsl(${m.hue} 85% 78%)` : undefined,
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="font-jetbrains text-[10px] uppercase tracking-widest text-white/45" htmlFor={`punch-char-${take.id}`}>
              character
            </label>
            <select
              id={`punch-char-${take.id}`}
              value={charId}
              onChange={(e) => setCharId(e.target.value)}
              className="font-jetbrains rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[11px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
            >
              {characters.map((c) => (
                <option key={c.character_id} value={c.character_id} className="bg-slate-900 text-white">{c.name}</option>
              ))}
            </select>
            <button
              onClick={() => void renderVariant()}
              disabled={rendering || engineBusy || !lane}
              title={
                !lane ? `Three lanes is the audition — discard one to render another`
                : engineBusy ? "The composer is rendering — one synthesis at a time on a CPU-only box"
                : "Render this region only (one segment, not the whole take)"
              }
              className="font-jetbrains cursor-pointer rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-[11px] text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {rendering ? "rendering lane…" : lane ? `▶ render lane ${lane}` : `lanes full (${MAX_LANES_PER_REGION})`}
            </button>
            <span className="font-jetbrains text-[10px] text-white/40">
              one segment costs one segment — the rest of the take is reused as-is
            </span>
          </div>

          {err && (
            <p role="alert" className="font-jetbrains mt-2 rounded-lg border border-rose-400/25 bg-rose-400/5 px-2.5 py-1.5 text-[11px] text-rose-200/90">
              {err}
            </p>
          )}

          {variants.length > 0 && (
            <PunchLanes
              variants={variants}
              committing={committing}
              onCommit={(v) => void commit(v)}
              onDiscard={discard}
            />
          )}

          <p className="font-jetbrains mt-3 border-t border-white/8 pt-2 text-[10px] leading-relaxed text-white/45">
            A splice joins at the segment edge with a 12 ms crossfade — where the engine already cuts. Prosody
            still drifts across a seam, so if the join reads wrong, ↺ reuse re-renders the whole take, which is
            always the clean option. Lanes: {LANES.join(" / ")}.
          </p>
        </div>
      )}
    </div>
  );
}
