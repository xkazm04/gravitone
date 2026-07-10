"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EMOTIONS } from "@/lib/emotions";
import type { Character, Voice } from "@/app/voices/_variants/data";

export type Slot = {
  emotion: string;
  label: string;
  hue: number;
  voice: Voice | null; // null = empty slot (falls back to baseline)
  demand: number; // unmet requests for this emotion (fallback telemetry)
};

/** One Character's emotion scale: which slots are filled, and how to fill them. */
export function useCharacterVoices(characterId: string) {
  const [character, setCharacter] = useState<Character | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/characters", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 503 ? "Gravitone backend unreachable" : `error ${r.status}`);
      const cs = (await r.json()) as Character[];
      setCharacter(cs.find((c) => c.character_id === characterId) ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load character");
    } finally {
      setLoading(false);
    }
  }, [characterId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const slots: Slot[] = useMemo(
    () =>
      EMOTIONS.map((e) => ({
        emotion: e.id,
        label: e.label,
        hue: e.hue,
        voice: character?.voices.find((v) => v.emotion === e.id) ?? null,
        demand: character?.demand?.[e.id] ?? 0,
      })),
    [character]
  );

  /** Clone a new Voice into an empty emotion slot.
   *  `rethrow` lets callers with their own error UI (GuidedRecorder) get the
   *  failure instead of the hook's shared error banner. */
  const addVoice = useCallback(
    async (emotion: string, file: File, opts: { rethrow?: boolean } = {}) => {
      if (!character) return;
      setBusySlot(emotion);
      setError(null);
      try {
        const fd = new FormData();
        fd.append("file", file, file.name);
        fd.append("character", character.name);
        fd.append("emotion", emotion);
        const r = await fetch("/api/voices", { method: "POST", body: fd });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.detail ?? `clone failed (${r.status})`);
        await refresh();
      } catch (e) {
        if (opts.rethrow) throw e;
        setError(e instanceof Error ? e.message : "clone failed");
      } finally {
        setBusySlot(null);
      }
    },
    [character, refresh]
  );

  const removeVoice = useCallback(
    async (voiceId: string) => {
      await fetch(`/api/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
      await refresh();
    },
    [refresh]
  );

  const coverage = slots.filter((s) => s.voice).length;

  return { character, slots, coverage, total: slots.length, loading, error, busySlot, addVoice, removeVoice, refresh };
}

/** Open a file picker for one emotion slot and hand the file back. */
export function pickAudio(onPick: (f: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*,video/mp4";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) onPick(f);
  };
  input.click();
}
