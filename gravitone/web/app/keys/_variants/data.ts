"use client";

import { useCallback, useEffect, useState } from "react";

import { authedFetch } from "@/lib/authedFetch";
import { throwDetail } from "@/lib/apiFetch";
import { useMounted } from "@/lib/useMounted";
import { forgetAttestation } from "./attestation";
import type { Posture, Sweep } from "./probes";

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

// SCOPES now lives in `capabilities.ts` — a PURE module, so the manifest route,
// the well-known document and the agent-config blocks can import the same list
// this create bar renders (a "use client" module cannot be imported by a server
// route, which is why the scope→endpoint mapping had nowhere to live). Re-
// exported here so every existing importer is unchanged.
export { SCOPES } from "./capabilities";
export type { ScopeInfo } from "./capabilities";

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
  // `unmeasured` until the probe answers — the absence of a posture, never
  // rendered as reassurance. See probes.ts::Posture for what each value proves.
  const [posture, setPosture] = useState<Posture>("unmeasured");
  const [postureCheckedAt, setPostureCheckedAt] = useState<string | null>(null);
  const mounted = useMounted();

  const refresh = useCallback(async () => {
    try {
      const r = await authedFetch("/api/keys", { cache: "no-store" });
      if (!r.ok) return await throwDetail(r, "failed to load keys");
      const list = (await r.json()) as ApiKey[];
      if (!mounted.current) return;
      setKeys(list);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : "failed to load keys");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [mounted]);

  /** Measure the posture: ONE unauthenticated GET, made by the server route so
   *  no root key is attached (`/api/keys/probe`). It carries no secret, spends
   *  no synth slot and mutates nothing — which is why this single probe is the
   *  one that may run without a click, while the scope sweep (a real synthesis
   *  among six requests) never does. An open deployment that nobody asked about
   *  is precisely the failure this feature exists to make impossible to miss. */
  const provePosture = useCallback(async (): Promise<Sweep | null> => {
    try {
      const r = await fetch("/api/keys/probe", { cache: "no-store" });
      if (!r.ok) return null;
      const sweep = (await r.json()) as Sweep;
      if (mounted.current) {
        setPosture(sweep.posture);
        setPostureCheckedAt(sweep.checkedAt);
      }
      return sweep;
    } catch {
      // A probe that could not even be dispatched says nothing; leaving the
      // posture as it was beats inventing "unreachable" for a studio-side fault.
      return null;
    }
  }, [mounted]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void provePosture(); }, [provePosture]);

  const createKey = useCallback(async (name: string, scopes: string[]) => {
    const r = await authedFetch("/api/keys", {
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
    const r = await authedFetch(`/api/keys/${encodeURIComponent(id)}`, { method: "POST" });
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
      const r = await authedFetch(`/api/keys/${encodeURIComponent(id)}/revoke`, { method: "POST" });
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
      const r = await authedFetch(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!mounted.current) return;
      if (!r.ok && r.status !== 404) {
        setKeys(snapshot);
        setError(`destroy failed (${r.status}) — the key still exists`);
        return;
      }
      // The proof outlives nothing: a destroyed key's attestation is a
      // statement about a credential that no longer exists.
      forgetAttestation(id);
      setError(null);
      await refresh();
    } catch {
      if (!mounted.current) return;
      setKeys(snapshot);
      setError("destroy failed — the key still exists");
    }
  }, [keys, mounted, refresh]);

  return {
    keys, loading, error, posture, postureCheckedAt, provePosture,
    refresh, createKey, rotateKey, revokeKey, destroyKey,
  };
}
