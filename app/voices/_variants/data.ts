"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

export function useCharacters() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/characters", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 503 ? "Gravitone backend unreachable" : `error ${r.status}`);
      setCharacters((await r.json()) as Character[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load characters");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Clone one Voice (character + emotion) from a recording. */
  const createVoice = useCallback(
    async (file: Blob, character: string, emotion: string, tags: string[] = [], filename = "recording.wav") => {
      const fd = new FormData();
      fd.append("file", file, filename);
      fd.append("character", character);
      fd.append("emotion", emotion);
      fd.append("tags", tags.join(","));
      const r = await fetch("/api/voices", { method: "POST", body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.detail ?? `clone failed (${r.status})`);
      await refresh();
      return body as Voice;
    },
    [refresh]
  );

  const patchCharacter = useCallback(async (id: string, patch: { name?: string; tags?: string[] }) => {
    setCharacters((cs) => cs.map((c) => (c.character_id === id ? { ...c, ...patch } : c)));
    const r = await fetch(`/api/characters/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
    if (!r.ok) await refresh();
  }, [refresh]);

  const deleteCharacter = useCallback(async (id: string) => {
    setCharacters((cs) => cs.filter((c) => c.character_id !== id));
    const r = await fetch(`/api/characters/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) await refresh();
  }, [refresh]);

  const deleteVoice = useCallback(async (voiceId: string) => {
    const r = await fetch(`/api/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
    await refresh();
    if (!r.ok) throw new Error("delete failed");
  }, [refresh]);

  return { characters, loading, error, refresh, createVoice, patchCharacter, deleteCharacter, deleteVoice };
}

/** Synthesize a short line with one Voice and play it. One preview at a time. */
export function useVoicePreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    setPlayingId(null);
  }, []);

  const preview = useCallback(
    async (voiceId: string, label: string, line?: string) => {
      if (playingId === voiceId) return stop();
      stop();
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
      } finally {
        setBusyId(null);
      }
    },
    [playingId, stop]
  );

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  return { preview, stop, playingId, busyId };
}
