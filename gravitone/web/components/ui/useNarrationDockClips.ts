"use client";

// Where the bytes come from and when they start. This hook owns the clip
// pipeline end to end: the build-time manifest, the cache count the dock
// reports, the cheapest-first fetch for one step, the loader that is the ONLY
// place playback begins, the one-sentence lookahead, and the object URL that
// has to be revoked when any of it goes away.

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject } from "react";

import {
  BAKED_MANIFEST, clipKey, parseManifest, taggedSentence,
  type BakeManifest, type NarrationStep,
} from "@/lib/narratable";
import { cacheAvailable, clearClips, countClips, getClip, putClip } from "@/lib/narrationCache";
import { pickNarrator, type Narrator } from "./narrationDockNarrator";
import {
  NarrationError, fetchBaked, recordNarrationTrace, synthesize, type ClipSource,
} from "./narrationDockSynthesis";
import type { DockEvent, DockPhase } from "./narrationDockState";

export function useNarrationDockClips({
  open, plan, phase, index, dispatch, roster, chosen, audioRef,
}: {
  open: boolean;
  plan: NarrationStep[];
  phase: DockPhase;
  index: number;
  dispatch: Dispatch<DockEvent>;
  roster: Narrator[] | null;
  chosen: string;
  audioRef: RefObject<HTMLAudioElement | null>;
}) {
  const [source, setSource] = useState<ClipSource>("live");
  const [cached, setCached] = useState(0);
  const [manifest, setManifest] = useState<BakeManifest | null>(null);
  // "This deployment HAS a bake and cannot serve it." Latched, because one
  // proven miss is enough to stop the status line claiming this page costs no
  // engine — the claim is false from that clip onward, not intermittently.
  const [bakeUnserved, setBakeUnserved] = useState(false);
  const onPromisedMiss = useCallback(() => setBakeUnserved(true), []);

  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    void countClips().then(setCached).catch(() => {});
  }, [open, index]);

  // ── the build-time bake, if this deployment has one ────────────────────────
  // Fetched once on first expand, alongside the roster. A 404 is the ordinary
  // case (no bake ran) and must cost nothing: no retry, no error state, no
  // mention in the UI beyond the status line not saying "baked".
  useEffect(() => {
    if (!open || manifest) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(BAKED_MANIFEST, { signal: ctrl.signal });
        if (!res.ok) return;
        const parsed = parseManifest(await res.json());
        if (parsed && !ctrl.signal.aborted) setManifest(parsed);
      } catch {
        /* no bake here — live synthesis is the normal path, not a degradation */
      }
    })();
    return () => ctrl.abort();
  }, [open, manifest]);

  // ── audio for one step: cache, then bake, then synth ───────────────────────
  //
  // Ordered by cost, cheapest first. The IndexedDB cache is free and local; a
  // baked file is a static asset off the CDN and costs no engine; synthesis
  // costs a synth slot on the box. Every layer is keyed identically, so moving
  // between them can never play the wrong audio — only reach the same audio
  // more or less cheaply.
  const ensureClip = useCallback(
    async (target: NarrationStep, signal: AbortSignal): Promise<{ blob: Blob; from: ClipSource }> => {
      const narrator = pickNarrator(roster ?? [], chosen, target.block.characterHint);
      if (!narrator) throw new NarrationError("no narrator is available on this deployment", "failed");
      const key = clipKey(narrator.character_id, target.block, target.sentence);
      const hit = await getClip(key);
      if (hit) return { blob: hit.blob, from: "cache" };
      const baked = await fetchBaked(manifest, key, signal, onPromisedMiss);
      if (baked) {
        await putClip(key, baked);
        return { blob: baked, from: "baked" };
      }
      const blob = await synthesize(narrator.character_id, taggedSentence(target.block, target.sentence), signal);
      await putClip(key, blob);
      return { blob, from: "live" };
    },
    [roster, chosen, manifest, onPromisedMiss],
  );

  // ── the loader: the only place that starts audio ───────────────────────────
  useEffect(() => {
    if (phase !== "loading") return;
    const target = plan[index];
    if (!target) {
      dispatch({ t: "stop" });
      return;
    }
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    let cancelled = false;

    (async () => {
      try {
        const { blob, from } = await ensureClip(target, ctrl.signal);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setSource(from);
        const el = audioRef.current;
        if (!el) throw new NarrationError("the player element is gone", "failed");
        el.src = url;
        try {
          await Promise.resolve(el.play?.());
        } catch {
          throw new NarrationError(
            "the browser blocked playback — press play once more", "blocked");
        }
        if (!cancelled) dispatch({ t: "started" });
      } catch (e) {
        if (cancelled || (e as { name?: string }).name === "AbortError") return;
        dispatch({ t: "fail", message: (e as Error).message || "narration failed" });
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [phase, index, plan, ensureClip, dispatch, audioRef]);

  // ── one-sentence lookahead ────────────────────────────────────────────────
  // Renders the NEXT sentence into the cache while this one plays, so the gap
  // between sentences is a beat and not a round-trip. Skipped when the cache is
  // unavailable, where it would spend a synth slot on audio nothing can keep.
  //
  // Its failures stay invisible to the visitor — a refused prefetch costs the
  // beat between sentences, and the sentence itself will be fetched again on
  // its own turn — but they are TRACED. A 429 here is the first evidence that
  // this page's reading is outrunning the engine, and a bare `catch(() => {})`
  // threw that evidence away.
  useEffect(() => {
    if (phase !== "playing" || !cacheAvailable()) return;
    const next = plan[index + 1];
    if (!next) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void ensureClip(next, ctrl.signal).catch((e: unknown) => {
        if ((e as { name?: string } | null)?.name === "AbortError") return;
        recordNarrationTrace({
          kind: "prefetch-failed",
          detail: `the lookahead for sentence ${index + 2} failed: ${
            (e as Error)?.message || "unknown reason"}`,
        });
      });
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [phase, index, plan, ensureClip]);

  // Object URLs outlive React state unless someone revokes them.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  const clearCache = useCallback(() => {
    void clearClips().then(() => setCached(0));
  }, []);

  return { source, cached, manifest, bakeUnserved, clearCache };
}
