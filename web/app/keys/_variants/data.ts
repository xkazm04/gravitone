"use client";

import { useCallback, useEffect, useState } from "react";

import { throwDetail } from "@/lib/apiFetch";
import { useMounted } from "@/lib/useMounted";

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

/** What the studio can HONESTLY say about whether this backend checks keys.
 *
 *  With `TTS_API_KEY` unset the service serves every unauthenticated request
 *  (`service/auth.py::_authorize` returns immediately), so the keys managed on
 *  this page enforce nothing at all. That is the single most misleading thing
 *  this surface can hide, so it is derived rather than assumed — and the three
 *  values are exactly what the studio can prove, no more:
 *
 *  - `enforced`  — the backend answered 401. Only a configured `TTS_API_KEY`
 *                  can produce that (open mode never rejects anyone), so key
 *                  enforcement is definitely ON.
 *  - `unknown`   — the list came back. This proves NOTHING about the posture:
 *                  the request went through the studio's server-side proxy,
 *                  which attaches its own root key when it has one
 *                  (`lib/backend.ts`), so a keyed backend and an open one look
 *                  identical from the browser. The studio says "I can't tell"
 *                  instead of guessing.
 *  - `unreachable` — nothing answered; there is no deployment to describe.
 *
 *  Determining `unknown` apart from open-mode would need an UNAUTHENTICATED
 *  probe of the backend, which only a server route could make (the browser
 *  can't: CORS is default-closed) — see the follow-ups in the build report. */
export type Enforcement = "enforced" | "unknown" | "unreachable";

export function useKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enforcement, setEnforcement] = useState<Enforcement>("unknown");
  const mounted = useMounted();

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      if (!r.ok) {
        if (mounted.current) {
          // 401 is the ONE status that proves a root key is configured. Every
          // other failure (503 unreachable, a 5xx, a proxy hiccup) says
          // nothing about the posture, so it must not be read as one.
          setEnforcement(r.status === 401 ? "enforced" : r.status === 503 ? "unreachable" : "unknown");
        }
        return await throwDetail(r, "failed to load keys");
      }
      const list = (await r.json()) as ApiKey[];
      if (!mounted.current) return;
      setKeys(list);
      // A served list means the proxy's credential (or the absence of any
      // check) was accepted — which of the two, this side cannot see.
      setEnforcement("unknown");
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : "failed to load keys");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [mounted]);

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

  /** Kill a key WITHOUT destroying its audit identity — the answer to a leak.
   *
   *  The key stops authenticating immediately but stays in the ledger with
   *  `revoked: true`, so its scopes and last-used remain answerable and a later
   *  rotate 409s. This is the default kill action; `destroyKey` is the one that
   *  takes the audit trail with it.
   *
   *  Optimistic: flip the row to revoked in place (it must stay VISIBLE — that
   *  is the whole point of revoke), with a snapshot to roll back to. A failure
   *  restores the live row and says the key is still active, because it is. */
  const revokeKey = useCallback(async (id: string) => {
    const snapshot = keys;
    setKeys((ks) => ks.map((k) => (k.id === id ? { ...k, revoked: true } : k)));
    try {
      const r = await fetch(`/api/keys/${encodeURIComponent(id)}/revoke`, { method: "POST" });
      if (!mounted.current) return;
      if (!r.ok) {
        setKeys(snapshot);
        setError(`revoke failed (${r.status}) — the key is still active`);
        return;
      }
      setError(null);
      await refresh();
    } catch {
      if (!mounted.current) return;
      setKeys(snapshot);
      setError("revoke failed — the key is still active");
    }
  }, [keys, mounted, refresh]);

  /** DESTROY a key and its audit record. Optimistically hide the row, but keep
   *  a snapshot: if the DELETE doesn't land, restore it rather than telling the
   *  user a key that still exists is gone. 404 = already absent, so success. */
  const destroyKey = useCallback(async (id: string) => {
    const snapshot = keys;
    setKeys((ks) => ks.filter((k) => k.id !== id));
    try {
      const r = await fetch(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!mounted.current) return;
      if (!r.ok && r.status !== 404) {
        setKeys(snapshot);
        setError(`destroy failed (${r.status}) — the key still exists`);
        return;
      }
      setError(null);
      await refresh();
    } catch {
      if (!mounted.current) return;
      setKeys(snapshot);
      setError("destroy failed — the key still exists");
    }
  }, [keys, mounted, refresh]);

  return { keys, loading, error, enforcement, refresh, createKey, rotateKey, revokeKey, destroyKey };
}
