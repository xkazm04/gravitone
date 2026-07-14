"use client";

// My Voices — the Personal Voice Vault rendered. Every voice this account
// cloned, with its consent attestation, playback, and revoke (deletes the
// engine's embedding AND marks the vault entry revoked — the provenance
// record itself is never deleted).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useVoicePreview, relTime } from "@/app/voices/_variants/data";
import { listVault, markRevoked, type VaultEntry } from "@/lib/voiceVault";

const METHOD_LABEL: Record<string, string> = {
  "self-recorded": "self-recorded",
  uploaded: "uploaded · consent attested",
  ingested: "from recording · consent attested",
};

export default function MyVoices({ uid }: { uid: string }) {
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { preview, playingId, busyId } = useVoicePreview();

  const refresh = useCallback(async () => {
    try { setEntries(await listVault(uid)); } catch { setEntries([]); }
  }, [uid]);
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

      {err && (
        <p className="font-jetbrains mt-3 rounded-lg border border-rose-400/25 bg-rose-400/5 px-3 py-2 text-[11px] text-rose-200">
          {err}
        </p>
      )}

      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-white/60">
          No cloned voices yet — every voice you clone is bound to this account with a consent
          attestation. Start in the <Link href="/voices" className="text-cyan-300 hover:text-cyan-200">roster</Link>.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {entries.map((e) => (
            <li key={e.voice_id}
              className={`flex flex-wrap items-center gap-3 rounded-xl border border-white/8 bg-black/25 px-3 py-2 ${e.revoked ? "opacity-50" : ""}`}>
              <button
                onClick={() => !e.revoked && preview(e.voice_id, `${e.character_name} ${e.emotion}`)}
                disabled={e.revoked || busyId === e.voice_id}
                aria-label={`Play ${e.character_name} ${e.emotion}`}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110 disabled:opacity-40"
              >
                {busyId === e.voice_id ? "…" : playingId === e.voice_id ? "⏸" : "▶"}
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-white">
                  {e.revoked ? <s>{e.character_name} · {e.emotion}</s> : (
                    <Link href={`/voices/${encodeURIComponent(e.character_id)}`} className="hover:text-cyan-200">
                      {e.character_name} · {e.emotion}
                    </Link>
                  )}
                </div>
                <div className="font-jetbrains truncate text-[11px] text-white/50" title={e.consent?.statement}>
                  {METHOD_LABEL[e.consent?.method] ?? e.consent?.method} · {relTime(e.created)}
                  {e.revoked && " · revoked"}
                </div>
              </div>
              {!e.revoked && (
                <button onClick={() => void revoke(e)} disabled={busy === e.voice_id}
                  className="font-jetbrains shrink-0 text-[11px] text-white/50 transition hover:text-rose-300 disabled:opacity-40">
                  {busy === e.voice_id ? "revoking…" : "revoke"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/40">
        Provenance ledger: who attested consent, how the audio was obtained, and when — kept even
        after a voice is revoked.
      </p>
    </div>
  );
}
