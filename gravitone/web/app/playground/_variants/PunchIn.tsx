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

import { useCallback, useEffect, useRef, useState } from "react";
import TakePlayer from "@/components/ui/TakePlayer";
import { emotionMeta, EMOTION_IDS } from "@/lib/emotions";
import type { Character } from "@/app/voices/_data/characters";
import TakeTimeline from "./TakeTimeline";
import { isAbort, speak, spliceRegion } from "./engine";
import {
  segmentRegions, type EditRegion, type Region, type Segment, type Take,
} from "./shared";
import {
  dropVariants, getVariants, LANES, MAX_LANES_PER_REGION, nextLane, putVariant, variantId,
  type Lane, type Variant,
} from "./variantStore";

/** What a committed lane hands back to the console, which owns take ids, the
 *  take log and persistence. */
export type CommitPayload = {
  blob: Blob;
  seconds: number;
  peaks: number[];
  segments: Segment[];
  /** D5 provenance for this patch. */
  region: EditRegion;
  /** Where the patched region sits in the new master, so the console can play
   *  the edit rather than the whole take. */
  start: number;
  /** What the patch render itself cost (the only honest timing a splice has). */
  synthSeconds: number;
  queueSeconds: number;
};

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
  // The take's real duration: X-Audio-Seconds when the backend reported one,
  // which is what the ribbon and the player already agree on.
  const duration = take.seconds > 0 ? take.seconds : 0;
  const regions: Region[] = segmentRegions(take.segments, duration);

  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [emotion, setEmotion] = useState<string | null>(null);
  const [charId, setCharId] = useState(take.characterId);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [rendering, setRendering] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const runRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      runRef.current?.abort();
    };
  }, []);

  // Object URLs are minted per lane (by variantStore on read, and here on
  // render) and this component owns revoking them.
  const revoke = useCallback((list: Variant[]) => {
    for (const v of list) if (v.url) URL.revokeObjectURL(v.url);
  }, []);
  useEffect(() => () => revoke(variants), [variants, revoke]);

  /** Pick a region: seek the take to it AND make it the punch-in target. */
  const pick = useCallback(
    (index: number) => {
      const r = regions[index];
      if (!r) return;
      onSeek(r.start);
      setSelected(index);
      setErr(null);
      setText(r.segment.text ?? "");
      setEmotion(null);
      setCharId(r.segment.characterId ?? take.characterId);
      // Lanes rendered before a refresh are still worth their CPU.
      void getVariants(take.id, index)
        .then((list) => {
          if (!aliveRef.current) { revoke(list); return; }
          setVariants((old) => { revoke(old); return list; });
        })
        .catch(() => {
          // A store we cannot read is not a reason to block an edit — it only
          // means this region starts with no lanes.
          if (aliveRef.current) setVariants((old) => { revoke(old); return []; });
        });
    },
    [regions, onSeek, take.id, take.characterId, revoke],
  );

  const region = selected !== null ? regions[selected] : undefined;
  const usedLanes = variants.map((v) => v.lane);
  const lane = nextLane(usedLanes);
  const scale = characters.find((c) => c.character_id === charId)?.scale?.length
    ? (characters.find((c) => c.character_id === charId)!.scale as string[])
    : EMOTION_IDS;

  /** The text actually sent for this lane: the region's text, wrapped in the
   *  chosen emotion. There is no emotion PARAMETER — a Character's emotions are
   *  separate Voices, selected by metatag — so a per-region override is a tag. */
  const renderText = (): string => {
    const t = text.trim();
    if (!t) return t;
    return emotion ? `[${emotion}]${t}[/${emotion}]` : t;
  };

  async function renderVariant() {
    if (!region || rendering || !lane) return;
    const body = renderText();
    if (!body) { setErr("Write the line this region should say."); return; }
    setRendering(true);
    setErr(null);
    const ctrl = new AbortController();
    runRef.current = ctrl;
    try {
      // Always wav for a lane: it is spliced into a wav master, and asking the
      // engine for mp3 here would mean decoding a lossy file to patch a lossless
      // one.
      // The BASE take's knobs, deliberately — not the composer's current ones.
      // A repair should sound like the take it is repairing, and the take carries
      // ONE `expr`, so a lane rendered with different sliders would make the code
      // export's patch call name settings that were never used.
      const r = await speak(body, charId, take.expr, ctrl.signal, "wav_24000");
      if (!aliveRef.current) return;
      if (r.mode !== "gravitone" || !r.blob) {
        // The browser voice cannot be spliced (there is no audio at all), and
        // saying so is better than producing a lane that will not commit.
        setErr(
          r.fallbackDetail
            ? `That region could not be re-rendered — ${r.fallbackDetail}. The take is untouched.`
            : "That region could not be re-rendered by Gravitone, so there is nothing to splice. The take is untouched.",
        );
        return;
      }
      const v: Variant = {
        id: variantId(take.id, region.index, lane),
        takeId: take.id, regionIndex: region.index, lane,
        text: body, emotion: emotion ?? undefined,
        characterId: charId, characterName: charName(charId),
        seconds: r.seconds, segments: r.segments, createdAt: Date.now(),
        blob: r.blob, url: URL.createObjectURL(r.blob),
      };
      setVariants((list) => [...list, v]);
      // Durability is a promise the log makes out loud, so a lane that is not
      // being kept has to be sayable — through the console's ONE storage banner.
      void putVariant(v)
        .then(() => { if (aliveRef.current) onStorageError(null); })
        .catch((e) => {
          if (!aliveRef.current) return;
          const why = e instanceof Error ? e.message : "storage unavailable";
          onStorageError(
            `Lane ${lane} is playable now but could NOT be saved for after a refresh (${why}). Commit it before reloading.`,
          );
        });
    } catch (e) {
      if (!aliveRef.current || isAbort(e)) return;
      setErr(e instanceof Error && e.message
        ? `That region could not be re-rendered — ${e.message}`
        : "That region could not be re-rendered. The take is untouched.");
    } finally {
      if (aliveRef.current) setRendering(false);
    }
  }

  function discard(v: Variant) {
    setVariants((list) => list.filter((x) => x.id !== v.id));
    if (v.url) URL.revokeObjectURL(v.url);
    void dropVariants(take.id, v.regionIndex).then(() => {
      // dropVariants clears the whole region; re-persist the survivors so
      // discarding lane Y does not silently un-save lane X.
      for (const keep of variants.filter((x) => x.id !== v.id)) void putVariant(keep).catch(() => {});
    });
  }

  async function commit(v: Variant) {
    if (committing) return;
    setCommitting(true);
    setErr(null);
    try {
      const spliced = await spliceRegion({
        base: take, regionIndex: v.regionIndex, fragment: v.blob, fragmentSegments: v.segments,
      });
      if (!aliveRef.current) return;
      if (!spliced) {
        // The documented degrade: a decode failure must never cost the user a
        // take, so the original is untouched and the escape hatch is named.
        setErr(
          "This take could not be spliced in your browser (the audio would not decode). Nothing was changed — " +
          "use ↺ reuse to re-render the whole take instead.",
        );
        return;
      }
      onCommit({
        blob: spliced.blob, seconds: spliced.seconds, peaks: spliced.peaks, segments: spliced.segments,
        region: { i: v.regionIndex, text: v.text, emotion: v.emotion, characterId: v.characterId },
        start: spliced.start,
        synthSeconds: 0, queueSeconds: 0,
      });
      // The lanes have served their purpose; the committed audio now lives in a
      // take, and keeping candidates around is exactly the IndexedDB growth this
      // feature has to not cause.
      revoke(variants);
      setVariants([]);
      void dropVariants(take.id, v.regionIndex);
      setSelected(null);
    } finally {
      if (aliveRef.current) setCommitting(false);
    }
  }

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
              onClick={() => { setSelected(null); revoke(variants); setVariants([]); }}
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
            <div className="mt-3 space-y-2">
              <span className="font-jetbrains text-[10px] uppercase tracking-widest text-white/45">
                lanes · audition, then commit one
              </span>
              {variants.map((v) => (
                <div key={v.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/20 p-2">
                  <span className="font-jetbrains grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/15 text-[11px] text-white/80">
                    {v.lane}
                  </span>
                  {v.url && <TakePlayer src={v.url} compact label={`lane ${v.lane}`} hue={emotionMeta(v.emotion ?? "baseline").hue} className="min-w-0 flex-1" />}
                  <span className="font-jetbrains shrink-0 text-[10px] text-white/50">
                    {v.seconds}s · {v.characterName}{v.emotion ? ` · ${v.emotion}` : ""}
                  </span>
                  <button
                    onClick={() => void commit(v)}
                    disabled={committing}
                    title="Splice this lane into a NEW take — the original stays in the log"
                    className="font-jetbrains shrink-0 cursor-pointer rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] text-emerald-200 transition hover:bg-emerald-400/20 disabled:opacity-40"
                  >
                    {committing ? "splicing…" : "✓ commit lane"}
                  </button>
                  <button
                    onClick={() => discard(v)}
                    aria-label={`Discard lane ${v.lane}`}
                    title="Discard this lane"
                    className="font-jetbrains shrink-0 cursor-pointer rounded-lg border border-white/12 px-2 py-1 text-[11px] text-white/55 transition hover:border-rose-400/40 hover:text-rose-200"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
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
