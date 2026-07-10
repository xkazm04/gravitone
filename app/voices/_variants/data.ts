"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Voice = {
  voice_id: string;
  name: string;
  category: "cloned" | "premade";
  tags: string[];
  lang: string;
  created?: string | null;
  sample_seconds?: number | null;
};

/** Stable hue per voice id, so a voice looks the same across every variant. */
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

export function useVoices() {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/voices", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 503 ? "Gravitone backend unreachable" : `error ${r.status}`);
      setVoices((await r.json()) as Voice[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load voices");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const createVoice = useCallback(
    async (file: Blob, name: string, tags: string[], filename = "recording.wav") => {
      const fd = new FormData();
      fd.append("file", file, filename);
      fd.append("name", name);
      fd.append("tags", tags.join(","));
      const r = await fetch("/api/voices", { method: "POST", body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.detail ?? `clone failed (${r.status})`);
      await refresh();
      return body as Voice;
    },
    [refresh]
  );

  const patchVoice = useCallback(async (id: string, patch: { name?: string; tags?: string[] }) => {
    setVoices((vs) => vs.map((v) => (v.voice_id === id ? { ...v, ...patch } : v))); // optimistic
    const r = await fetch(`/api/voices/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) await refresh();
  }, [refresh]);

  const removeVoice = useCallback(async (id: string) => {
    setVoices((vs) => vs.filter((v) => v.voice_id !== id)); // optimistic
    const r = await fetch(`/api/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) await refresh();
  }, [refresh]);

  return { voices, loading, error, refresh, createVoice, patchVoice, removeVoice };
}

/** Synthesize a short line with a voice and play it. One preview at a time. */
export function useVoicePreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    setPlayingId(null);
  }, []);

  const preview = useCallback(
    async (voice: Voice, line?: string) => {
      if (playingId === voice.voice_id) return stop();
      stop();
      setBusyId(voice.voice_id);
      try {
        const text = line ?? `Hi, this is ${voice.name}. This is how I sound.`;
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voiceId: voice.voice_id }),
        });
        if (!r.ok) throw new Error("preview failed");
        const url = URL.createObjectURL(await r.blob());
        if (!audioRef.current) audioRef.current = new Audio();
        const a = audioRef.current;
        a.src = url;
        a.onended = () => setPlayingId(null);
        await a.play();
        setPlayingId(voice.voice_id);
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
