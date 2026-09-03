"use client";

// My Voices — the Personal Voice Vault rendered. Every voice this account
// cloned, with its consent attestation, playback, and revoke (deletes the
// engine's embedding AND marks the vault entry revoked — the provenance
// record itself is never deleted).

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useVoicePreview } from "@/app/voices/_variants/data";
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import { useMounted } from "@/lib/useMounted";
import {
  listVault, markRevoked, requestSignoff, type VaultEntry,
} from "@/lib/voiceVault";
import MyVoicesRow from "./MyVoicesRow";

export { SignoffBadgePill } from "./ProfileSignoffBadge";

export default function MyVoices({ uid }: { uid: string }) {
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mounted = useMounted();
  const { preview, playingId, busyId } = useVoicePreview();
  const { copy, copied, failed } = useCopyFeedback<string>();

  const refresh = useCallback(async () => {
    try {
      const list = await listVault(uid);
      if (!mounted.current) return;
      setEntries(list);
    } catch {
      // A vault read failure must NOT render the "No cloned voices yet" empty
      // state — that would tell the user their consent-logged voices are gone.
      if (!mounted.current) return;
      setEntries([]);
      setErr("couldn't load your voice vault — reload to retry (your voices are safe)");
    }
  }, [uid, mounted]);
  useEffect(() => { void refresh(); }, [refresh]);

  const revoke = useCallback(async (e: VaultEntry) => {
    if (!window.confirm(`Revoke "${e.character_name} · ${e.emotion}"? The voice embedding is deleted; the consent record is kept.`)) return;
    setBusy(e.voice_id);
    setErr(null);
    try {
      // The engine delete MUST succeed before we tell the user the voice is
      // gone — fetch resolves on any HTTP status, so check r.ok. A 404 means
      // the engine already has no such voice, which we treat as deleted.
      const r = await fetch(`/api/voices/${encodeURIComponent(e.voice_id)}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) {
        throw new Error(`the voice could not be deleted (${r.status}) — it is still usable`);
      }
      const marked = await markRevoked(uid, e.voice_id);
      if (!marked) {
        throw new Error("the voice was deleted, but the vault record could not be updated — reload and retry");
      }
      await refresh();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "revoke failed");
      await refresh(); // reconcile the list with the real state
    } finally { setBusy(null); }
  }, [uid, refresh]);

  const ask = useCallback(async (e: VaultEntry) => {
    setAsking(e.voice_id);
    setErr(null);
    try {
      await requestSignoff(uid, e.voice_id);
      await refresh();
    } catch (e2) {
      setErr(e2 instanceof Error
        ? `sign-off request not saved (${e2.message}) — the link would not work, so none was made`
        : "sign-off request not saved");
    } finally { setAsking(null); }
  }, [uid, refresh]);

  if (entries === null) {
    return <p className="font-jetbrains text-[12px] text-white/50">loading voice vault…</p>;
  }

  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="flex items-baseline justify-between">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          my voices — vault
        </span>
        <span className="font-jetbrains text-[11px] text-white/45">
          {entries.filter((e) => !e.revoked).length} active · consent-logged
        </span>
      </div>

      {err && <ErrorBanner className="mt-3">{err}</ErrorBanner>}

      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-white/60">
          No cloned voices yet — every voice you clone is bound to this account with a consent
          attestation. Start in the <Link href="/voices" className="text-cyan-300 hover:text-cyan-200">roster</Link>.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {entries.map((e) => (
            <MyVoicesRow
              key={e.voice_id}
              e={e}
              uid={uid}
              preview={preview}
              playingId={playingId}
              busyId={busyId}
              copy={copy}
              copied={copied}
              failed={failed}
              asking={asking}
              onAsk={() => void ask(e)}
              busy={busy}
              onRevoke={() => void revoke(e)}
            />
          ))}
        </ul>
      )}
      <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/40">
        Provenance ledger: who attested consent, how the audio was obtained, and when — kept even
        after a voice is revoked. Sign-off is the upgrade: a second party signs, with scope and an
        expiry. Enforcement is client-side in v1 — this studio honours a withdrawal, the engine
        cannot yet.
      </p>
    </div>
  );
}
