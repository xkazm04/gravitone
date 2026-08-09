"use client";

// The punch-in EDITING SESSION — everything PunchIn does that is not drawing.
//
// One region is selected at a time, and the session holds what that selection
// means: the words being rewritten, the emotion / Character they are rewritten
// under, the audition lanes rendered for them (persisted through variantStore),
// and the two terminal verbs — discard a lane, or commit one through the splice
// kernel. The panel above it is then a pure rendering of this state.

import { useCallback, useEffect, useRef, useState } from "react";
import { EMOTION_IDS } from "@/lib/emotions";
import type { Character } from "@/app/voices/_data/characters";
import { isAbort, speak, spliceRegion } from "./playgroundEngine";
import { segmentRegions, type Region, type Take } from "./playgroundHelpers";
import {
  dropVariants, getVariants, nextLane, putVariant, variantId,
  type Variant,
} from "./variantStore";
import type { CommitPayload } from "./punchTypes";

export function usePunchSession({
  take,
  characters,
  charName,
  onSeek,
  onCommit,
  onStorageError,
}: {
  take: Take;
  characters: Character[];
  charName: (id: string) => string;
  onSeek: (seconds: number) => void;
  onCommit: (p: CommitPayload) => void;
  onStorageError: (message: string | null) => void;
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

  /** Leave the region without committing anything: the lanes it rendered are
   *  dropped from the screen (and their object URLs revoked) but stay in the
   *  store, so re-opening the region finds them again. */
  function close() {
    setSelected(null);
    revoke(variants);
    setVariants([]);
  }

  return {
    regions, selected, region, lane, scale,
    text, setText, emotion, setEmotion, charId, setCharId,
    variants, rendering, committing, err,
    pick, renderVariant, discard, commit, close,
  };
}
