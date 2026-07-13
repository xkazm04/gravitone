"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EMOTIONS, emotionMeta, isBaseEmotion } from "@/lib/emotions";
import { useAuth } from "@/lib/useAuth";
import { recordVoiceOwnership, type ConsentMethod } from "@/lib/voiceVault";
import type { Character, Voice } from "@/app/voices/_variants/data";

export type Slot = {
  emotion: string;
  label: string;
  hue: number;
  custom: boolean; // beyond the base scale — art is a generated sigil
  voice: Voice | null; // null = empty slot (falls back to baseline)
  demand: number; // unmet requests for this emotion (fallback telemetry)
};

/** One Character's emotion scale: which slots are filled, and how to fill them. */
export function useCharacterVoices(characterId: string) {
  const { user } = useAuth();
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

  // The Character's own palette: the base scale plus any custom slots it
  // declared ("sarcastic", "battle_cry"). Falls back to the base eight while
  // the character is still loading.
  const slots: Slot[] = useMemo(() => {
    const scale = character?.scale?.length ? character.scale : EMOTIONS.map((e) => e.id);
    return scale.map((id) => {
      const m = emotionMeta(id);
      return {
        emotion: id,
        label: m.label,
        hue: m.hue,
        custom: !isBaseEmotion(id),
        voice: character?.voices.find((v) => v.emotion === id) ?? null,
        demand: character?.demand?.[id] ?? 0,
      };
    });
  }, [character]);

  /** Mint a new custom emotion slot on this Character. */
  const addCustomEmotion = useCallback(async (name: string) => {
    const r = await fetch(`/api/characters/${encodeURIComponent(characterId)}/emotions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.detail ?? `could not add "${name}"`);
    await refresh();
  }, [characterId, refresh]);

  /** Remove an EMPTY custom slot (the backend 409s if a Voice occupies it). */
  const removeCustomEmotion = useCallback(async (emotion: string) => {
    const r = await fetch(
      `/api/characters/${encodeURIComponent(characterId)}/emotions/${encodeURIComponent(emotion)}`,
      { method: "DELETE" },
    );
    if (!r.ok && r.status !== 404) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body?.detail ?? "could not remove the slot");
    }
    await refresh();
  }, [characterId, refresh]);

  /** Clone a new Voice into an empty emotion slot.
   *  `rethrow` lets callers with their own error UI (GuidedRecorder) get the
   *  failure instead of the hook's shared error banner. `consent` names how
   *  the audio was obtained — it becomes the Voice Vault attestation. */
  const addVoice = useCallback(
    async (emotion: string, file: File, opts: { rethrow?: boolean; consent?: ConsentMethod } = {}) => {
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
        if (user) {
          const v = body as Voice;
          void recordVoiceOwnership(user, [{
            voice_id: v.voice_id, character_id: v.character_id,
            character_name: character.name, emotion: v.emotion,
          }], opts.consent ?? "uploaded");
        }
        await refresh();
      } catch (e) {
        if (opts.rethrow) throw e;
        setError(e instanceof Error ? e.message : "clone failed");
      } finally {
        setBusySlot(null);
      }
    },
    [character, refresh, user]
  );

  const removeVoice = useCallback(
    async (voiceId: string) => {
      await fetch(`/api/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
      await refresh();
    },
    [refresh]
  );

  const coverage = slots.filter((s) => s.voice).length;

  return { character, slots, coverage, total: slots.length, loading, error, busySlot,
           addVoice, removeVoice, addCustomEmotion, removeCustomEmotion, refresh };
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
