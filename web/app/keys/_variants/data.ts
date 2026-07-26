"use client";

import { useCallback, useEffect, useState } from "react";

import { apiJson, throwDetail } from "@/lib/apiFetch";

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
      setKeys(await apiJson<ApiKey[]>("/api/keys", { cache: "no-store" },
        "failed to load keys"));
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
    if (!r.ok) return throwDetail(r, `create failed (${r.status})`);
    const body = (await r.json()) as ApiKeyWithSecret;
    await refresh();
    return body;
  }, [refresh]);

  const rotateKey = useCallback(async (id: string) => {
    // The backend's detail matters here: "cannot rotate a revoked key" is a
    // different user action than a transport failure.
    const r = await fetch(`/api/keys/${encodeURIComponent(id)}`, { method: "POST" });
    if (!r.ok) return throwDetail(r, `rotate failed (${r.status})`);
    const body = (await r.json()) as ApiKeyWithSecret;
    await refresh();
    return body;
  }, [refresh]);

  const deleteKey = useCallback(async (id: string) => {
    // Optimistically hide the row, but keep a snapshot: if the DELETE doesn't
    // actually revoke the key, restore it so the user is not told a still-live
    // (possibly leaked) key is gone. 404 = already absent, treat as success.
    const snapshot = keys;
    setKeys((ks) => ks.filter((k) => k.id !== id));
    try {
      const r = await fetch(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) {
        setKeys(snapshot);
        setError(`revoke failed (${r.status}) — the key is still active`);
        return;
      }
      setError(null);
      await refresh();
    } catch {
      setKeys(snapshot);
      setError("revoke failed — the key is still active");
    }
  }, [keys, refresh]);

  return { keys, loading, error, refresh, createKey, rotateKey, deleteKey };
}
