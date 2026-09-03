"use client";

// The gate in front of the speaker's page. The link is a secret, so this hook
// decides what — if anything — may be shown, and it is the only place that
// reads the owner's vault row.

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { useMounted } from "@/lib/useMounted";
import { loadVaultEntry, signoffState, tokenMatches, type VaultEntry } from "@/lib/voiceVault";

export type Gate =
  | { kind: "link-incomplete" }
  | { kind: "signin" }
  | { kind: "loading" }
  | { kind: "unreadable"; message: string }
  | { kind: "invalid" }
  | { kind: "grant"; entry: VaultEntry }
  | { kind: "settled"; entry: VaultEntry };

export function useSignoffGate({
  voiceId, ownerUid, token,
}: { voiceId: string; ownerUid: string | null; token: string | null }) {
  const { user, loading, ready, authResolved, signIn } = useAuth();
  const mounted = useMounted();

  const [entry, setEntry] = useState<VaultEntry | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // The record is only fetched once the visitor is authenticated: the Firestore
  // rule that lets a link holder read one vault row requires a signed-in
  // reader, so an anonymous visitor never touches the owner's data at all.
  useEffect(() => {
    if (!user || !ownerUid || !token || loadState !== "idle") return;
    setLoadState("loading");
    void (async () => {
      try {
        const e = await loadVaultEntry(ownerUid, voiceId);
        if (!mounted.current) return;
        setEntry(e);
        setLoadState("loaded");
      } catch (err) {
        if (!mounted.current) return;
        // A rules refusal and a missing voice look the same from here; say what
        // we know rather than inventing a reason.
        setLoadErr(err instanceof Error ? err.message : "the sign-off request could not be read");
        setLoadState("error");
      }
    })();
  }, [user, ownerUid, token, voiceId, loadState, mounted]);

  const gate: Gate = useMemo(() => {
    if (!ownerUid || !token) return { kind: "link-incomplete" };
    if (!ready || (!authResolved && loading)) return { kind: "loading" };
    if (!user) return { kind: "signin" };
    if (loadState === "idle" || loadState === "loading") return { kind: "loading" };
    if (loadState === "error") return { kind: "unreadable", message: loadErr ?? "unreadable" };
    if (!entry || !tokenMatches(entry.consent?.signoff?.token, token)) return { kind: "invalid" };
    const state = signoffState(entry.consent?.signoff);
    if (state === "pending" || state === "declined") return { kind: "grant", entry };
    return { kind: "settled", entry };
  }, [ownerUid, token, ready, authResolved, loading, user, loadState, loadErr, entry]);

  return { gate, entry, user, ready, signIn };
}
