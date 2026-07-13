"use client";

// ── ONE data layer for Character & Voice management ───────────────────────────
// The roster page (/voices) and the detail page (/voices/[id]) both consume this
// module. It owns every fetch/CRUD/preview against the /api/characters and
// /api/voices proxies, so the two pages can never drift apart again (they used
// to keep two parallel copies of the clone/delete logic). Mutations surface
// their failures to callers; nothing is swallowed.

import { useCallback, useEffect, useRef, useState } from "react";
import { CONSENT_STATEMENT } from "@/lib/consent";
import { EMOTIONS, emotionMeta, isBaseEmotion } from "@/lib/emotions";
import { useAuth } from "@/lib/useAuth";
import { recordVoiceOwnership, type ConsentMethod } from "@/lib/voiceVault";

/** One speaker in ONE emotion. */
export type Voice = {
  voice_id: string;
  character_id: string;
  emotion: string;
  name: string;
  category: "cloned" | "premade";
  lang: string;
  created?: string | null;
  sample_seconds?: number | null;
  // True when a consent receipt is on file for this voice (ingest / attested
  // clone). Pre-consent and built-in voices report false.
  consent?: boolean;
};

/** A group of Voices across the emotion scale. */
export type Character = {
  character_id: string;
  name: string;
  category: "cloned" | "premade";
  tags: string[];
  lang: string;
  voices: Voice[];
  emotions: string[];
  coverage: number;
  total: number;
  created?: string | null;
  // Fallback telemetry: unmet requests per still-missing emotion.
  demand?: Record<string, number>;
  // This Character's effective palette: base scale + its custom slots.
  scale?: string[];
  custom_emotions?: string[];
  // Pack-import provenance when this Character came from a .gravichar import.
  imported?: { from: string; at: string } | null;
};

/** One Character's emotion scale: which slots are filled, and how to fill them. */
export type Slot = {
  emotion: string;
  label: string;
  hue: number;
  custom: boolean; // beyond the base scale — art is a generated sigil
  voice: Voice | null; // null = empty slot (falls back to baseline)
  demand: number; // unmet requests for this emotion (fallback telemetry)
};

export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function relTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return "—";
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── request helpers ───────────────────────────────────────────────────────────
// One place that turns a non-OK proxy response into an Error carrying the
// backend's `detail` (or a sensible fallback). Every mutation below routes its
// failures through here so callers get a real message to show, never silence.
async function throwDetail(r: Response, fallback: string): Promise<never> {
  const body = await r.json().catch(() => ({} as { detail?: string }));
  throw new Error(
    body?.detail ?? (r.status === 503 ? "Gravitone backend unreachable" : fallback),
  );
}

async function fetchRoster(): Promise<Character[]> {
  const r = await fetch("/api/characters", { cache: "no-store" });
  if (!r.ok) throw new Error(r.status === 503 ? "Gravitone backend unreachable" : `error ${r.status}`);
  return (await r.json()) as Character[];
}

/** Fetch ONE Character (the detail page). Returns null on 404 so the page can
 *  render its "no such character" state. Downloading the whole roster to
 *  `.find()` a single character was the old, wasteful path. */
async function fetchCharacter(id: string): Promise<Character | null> {
  const r = await fetch(`/api/characters/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(r.status === 503 ? "Gravitone backend unreachable" : `error ${r.status}`);
  return (await r.json()) as Character;
}

/** Clone one Voice (character + emotion) from a recording. Throws on failure. */
export async function cloneVoice(
  character: string,
  emotion: string,
  file: Blob,
  opts: { tags?: string[]; filename?: string } = {},
): Promise<Voice> {
  const fd = new FormData();
  fd.append("file", file, opts.filename ?? (file as File).name ?? "recording.wav");
  fd.append("character", character);
  fd.append("emotion", emotion);
  fd.append("tags", (opts.tags ?? []).join(","));
  fd.append("attested", "true"); // ownership attestation (gated in the UI)
  fd.append("statement", CONSENT_STATEMENT);
  const r = await fetch("/api/voices", { method: "POST", body: fd });
  if (!r.ok) return throwDetail(r, `clone failed (${r.status})`);
  return (await r.json()) as Voice;
}

/** Delete a cloned Voice. Throws on failure (404 included — the slot is gone). */
export async function deleteVoiceReq(voiceId: string): Promise<void> {
  const r = await fetch(`/api/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
  if (!r.ok) return throwDetail(r, "delete failed");
}

/** Rename / retag a Character; returns the server-normalized Character. */
export async function patchCharacterReq(
  id: string,
  patch: { name?: string; tags?: string[] },
): Promise<Character> {
  const r = await fetch(`/api/characters/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) return throwDetail(r, `update failed (${r.status})`);
  return (await r.json()) as Character;
}

export async function deleteCharacterReq(id: string): Promise<void> {
  const r = await fetch(`/api/characters/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) return throwDetail(r, "delete failed");
}

export async function addCustomEmotionReq(id: string, name: string): Promise<void> {
  const r = await fetch(`/api/characters/${encodeURIComponent(id)}/emotions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) return throwDetail(r, `could not add "${name}"`);
}

export async function removeCustomEmotionReq(id: string, emotion: string): Promise<void> {
  const r = await fetch(
    `/api/characters/${encodeURIComponent(id)}/emotions/${encodeURIComponent(emotion)}`,
    { method: "DELETE" },
  );
  if (!r.ok && r.status !== 404) return throwDetail(r, "could not remove the slot");
}

// ── roster hook ───────────────────────────────────────────────────────────────
export function useCharacters() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCharacters(await fetchRoster());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load characters");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Clone one Voice from a recording. Throws so the caller's banner can show it. */
  const createVoice = useCallback(
    async (file: Blob, character: string, emotion: string, tags: string[] = [], filename = "recording.wav") => {
      const v = await cloneVoice(character, emotion, file, { tags, filename });
      await refresh();
      return v;
    },
    [refresh],
  );

  const patchCharacter = useCallback(async (id: string, patch: { name?: string; tags?: string[] }) => {
    setCharacters((cs) => cs.map((c) => (c.character_id === id ? { ...c, ...patch } : c))); // optimistic
    try {
      const updated = await patchCharacterReq(id, patch);
      // Re-sync from the server so normalized values (lowercased tags, trimmed
      // name) replace the optimistic guess.
      setCharacters((cs) => cs.map((c) => (c.character_id === id ? updated : c)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed");
      await refresh(); // roll the optimistic edit back to server truth
    }
  }, [refresh]);

  const deleteCharacter = useCallback(async (id: string) => {
    setCharacters((cs) => cs.filter((c) => c.character_id !== id)); // optimistic
    try {
      await deleteCharacterReq(id);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
      await refresh(); // restore the row we optimistically removed
    }
  }, [refresh]);

  return { characters, loading, error, refresh, createVoice, patchCharacter, deleteCharacter };
}

// ── detail hook ─────────────────────────────────────────────────────────────
/** One Character's emotion scale: which slots are filled, and how to fill them. */
export function useCharacter(characterId: string) {
  const { user } = useAuth();
  const [character, setCharacter] = useState<Character | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCharacter(await fetchCharacter(characterId));
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
  const slots: Slot[] = (character?.scale?.length ? character.scale : EMOTIONS.map((e) => e.id)).map((id) => {
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

  /** Mint a new custom emotion slot on this Character. */
  const addCustomEmotion = useCallback(async (name: string) => {
    await addCustomEmotionReq(characterId, name);
    await refresh();
  }, [characterId, refresh]);

  /** Remove an EMPTY custom slot (the backend 409s if a Voice occupies it). */
  const removeCustomEmotion = useCallback(async (emotion: string) => {
    await removeCustomEmotionReq(characterId, emotion);
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
        const v = await cloneVoice(character.name, emotion, file, { filename: file.name });
        if (user) {
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
    [character, refresh, user],
  );

  const removeVoice = useCallback(
    async (voiceId: string) => {
      setError(null);
      try {
        await deleteVoiceReq(voiceId);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "delete failed");
      }
    },
    [refresh],
  );

  const coverage = slots.filter((s) => s.voice).length;

  return { character, slots, coverage, total: slots.length, loading, error, busySlot,
           addVoice, removeVoice, addCustomEmotion, removeCustomEmotion, refresh };
}

// ── preview hook ────────────────────────────────────────────────────────────
/** Synthesize a short line with one Voice and play it. One preview at a time.
 *  A failed preview surfaces briefly as `failedId` (no longer swallowed). */
export function useVoicePreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const failTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    setPlayingId(null);
  }, []);

  const preview = useCallback(
    async (voiceId: string, label: string, line?: string) => {
      if (playingId === voiceId) return stop();
      stop();
      setFailedId(null);
      if (failTimer.current) clearTimeout(failTimer.current);
      setBusyId(voiceId);
      try {
        const text = line ?? `Hi, this is ${label}. This is how I sound.`;
        const r = await fetch("/api/tts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voiceId }),
        });
        if (!r.ok) throw new Error("preview failed");
        const url = URL.createObjectURL(await r.blob());
        if (!audioRef.current) audioRef.current = new Audio();
        const a = audioRef.current;
        a.src = url;
        a.onended = () => setPlayingId(null);
        await a.play();
        setPlayingId(voiceId);
      } catch {
        setPlayingId(null);
        // Surface a brief "preview failed" pip; auto-clear so it stays quiet.
        setFailedId(voiceId);
        failTimer.current = setTimeout(() => setFailedId(null), 2600);
      } finally {
        setBusyId(null);
      }
    },
    [playingId, stop],
  );

  useEffect(() => () => {
    audioRef.current?.pause();
    if (failTimer.current) clearTimeout(failTimer.current);
  }, []);

  return { preview, stop, playingId, busyId, failedId };
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
