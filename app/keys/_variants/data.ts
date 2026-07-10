"use client";

import { useCallback, useEffect, useState } from "react";

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created: string;
  last_used: string | null;
  revoked: boolean;
};
export type ApiKeyWithSecret = ApiKey & { secret: string };

export const SCOPES: { id: string; label: string; hint: string }[] = [
  { id: "tts", label: "Synthesize", hint: "generate speech" },
  { id: "voices", label: "Manage voices", hint: "rename / retag / delete" },
  { id: "clone", label: "Clone", hint: "upload & create voices" },
  { id: "performance", label: "Performance", hint: "multi-character scripts (/v1/performance) — the premium tier" },
];

export function relTime(iso?: string | null): string {
  if (!iso) return "never";
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return "never";
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function useKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 503 ? "Gravitone backend unreachable" : `error ${r.status}`);
      setKeys((await r.json()) as ApiKey[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const createKey = useCallback(async (name: string, scopes: string[]) => {
    const r = await fetch("/api/keys", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, scopes }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.detail ?? `create failed (${r.status})`);
    await refresh();
    return body as ApiKeyWithSecret;
  }, [refresh]);

  const rotateKey = useCallback(async (id: string) => {
    const r = await fetch(`/api/keys/${encodeURIComponent(id)}`, { method: "POST" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("rotate failed");
    await refresh();
    return body as ApiKeyWithSecret;
  }, [refresh]);

  const deleteKey = useCallback(async (id: string) => {
    setKeys((ks) => ks.filter((k) => k.id !== id));
    const r = await fetch(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) await refresh();
  }, [refresh]);

  return { keys, loading, error, refresh, createKey, rotateKey, deleteKey };
}
