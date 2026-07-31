"use client";

// My Voices — the Personal Voice Vault rendered. Every voice this account
// cloned, with its consent attestation, playback, and revoke (deletes the
// engine's embedding AND marks the vault entry revoked — the provenance
// record itself is never deleted).

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useVoicePreview, relTime } from "@/app/voices/_variants/data";
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import { useMounted } from "@/lib/useMounted";
import {
  isConsentBlocked, listVault, markRevoked, requestSignoff, signoffBadge, signoffLink,
  signoffState, type SignoffBadge, type VaultEntry,
} from "@/lib/voiceVault";

const METHOD_LABEL: Record<string, string> = {
  "self-recorded": "self-recorded",
  uploaded: "uploaded · consent attested",
  ingested: "from recording · consent attested",
};

const BADGE_CLASS: Record<SignoffBadge["tone"], string> = {
  strong: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  pending: "border-white/15 bg-white/5 text-white/60",
  alert: "border-amber-400/40 bg-amber-400/10 text-amber-200",
};

export function SignoffBadgePill({ badge }: { badge: SignoffBadge | null }) {
  // Absent = invisible: a self-attested voice carries no badge at all, so the
  // speaker-signed one stays the strongest thing on the row.
  if (!badge) return null;
  return (
    <span className={`font-jetbrains shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${BADGE_CLASS[badge.tone]}`}>
      {badge.label}
    </span>
  );
}

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
          {entries.map((e) => {
            const state = signoffState(e.consent?.signoff);
            const blocked = isConsentBlocked(state);
            // Expired or withdrawn consent reads exactly like a revoked voice:
            // struck-through, unplayable, and asking the owner to finish it.
            const dead = e.revoked || blocked;
            const signoff = e.consent?.signoff;
            const link = signoff && typeof window !== "undefined"
              ? signoffLink(window.location.origin, uid, e.voice_id, signoff.token)
              : null;
            return (
            <li key={e.voice_id}
              className={`flex flex-wrap items-center gap-3 rounded-xl border border-white/8 bg-black/25 px-3 py-2 ${dead ? "opacity-50" : ""}`}>
              <button
                onClick={() => !dead && preview(e.voice_id, `${e.character_name} ${e.emotion}`)}
                disabled={dead || busyId === e.voice_id}
                aria-label={`Play ${e.character_name} ${e.emotion}`}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110 disabled:opacity-40"
              >
                {busyId === e.voice_id ? "…" : playingId === e.voice_id ? "⏸" : "▶"}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 truncate text-sm text-white">
                  {dead ? <s>{e.character_name} · {e.emotion}</s> : (
                    <Link href={`/voices/${encodeURIComponent(e.character_id)}`} className="hover:text-cyan-200">
                      {e.character_name} · {e.emotion}
                    </Link>
                  )}
                  <SignoffBadgePill badge={signoffBadge(state)} />
                </div>
                <div className="font-jetbrains truncate text-[11px] text-white/50" title={e.consent?.statement}>
                  {METHOD_LABEL[e.consent?.method] ?? e.consent?.method} · {relTime(e.created)}
                  {e.revoked && " · revoked"}
                  {state === "signed" && signoff?.speakerEmail && ` · signed by ${signoff.speakerEmail}`}
                  {state === "signed" && signoff?.scope?.expiresAt && ` · until ${signoff.scope.expiresAt}`}
                </div>
                {state === "signed" && (signoff?.scope?.purpose || signoff?.scope?.exclusions?.length) && (
                  <div className="font-jetbrains mt-1 text-[11px] text-white/45">
                    {signoff.scope?.purpose && <>scope: {signoff.scope.purpose}</>}
                    {signoff.scope?.exclusions?.length ? ` · excluded: ${signoff.scope.exclusions.join(", ")}` : ""}
                  </div>
                )}
                {state === "pending" && signoff && (
                  <div className="mt-2 rounded-lg border border-white/10 bg-black/30 p-2">
                    <div className="font-jetbrains text-[11px] text-white/55">
                      verification phrase — the speaker reads this back:
                    </div>
                    <div className="font-jetbrains mt-1 text-[11px] text-cyan-200">{signoff.phrase}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <code className="font-jetbrains min-w-0 flex-1 truncate rounded border border-white/10 bg-black/40 px-2 py-1 text-[10px] text-white/60">
                        {link ?? "…"}
                      </code>
                      <button
                        onClick={() => link && void copy(link, e.voice_id)}
                        className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-2 py-1 text-[10px] text-white/80 transition hover:bg-white/5"
                      >
                        {failed === e.voice_id ? "copy blocked — select it"
                          : copied === e.voice_id ? "✓ copied" : "copy invite link"}
                      </button>
                    </div>
                    <p className="font-jetbrains mt-1 text-[10px] text-white/40">
                      No email is sent — send this link yourself. It is the only way in, so treat it
                      as a secret.
                    </p>
                  </div>
                )}
                {blocked && (
                  <div className="font-jetbrains mt-1 text-[11px] text-amber-200">
                    {state === "withdrawn"
                      ? "the speaker withdrew consent — delete this voice to honour it"
                      : "the granted period ended — delete this voice or ask for a new sign-off"}
                  </div>
                )}
              </div>
              {!e.revoked && state === "self" && (
                <button onClick={() => void ask(e)} disabled={asking === e.voice_id}
                  className="font-jetbrains shrink-0 text-[11px] text-cyan-300/80 transition hover:text-cyan-200 disabled:opacity-40">
                  {asking === e.voice_id ? "creating…" : "request sign-off"}
                </button>
              )}
              {!e.revoked && (state === "declined" || blocked) && (
                <button onClick={() => void ask(e)} disabled={asking === e.voice_id}
                  className="font-jetbrains shrink-0 text-[11px] text-white/50 transition hover:text-cyan-200 disabled:opacity-40">
                  {asking === e.voice_id ? "creating…" : "ask again"}
                </button>
              )}
              {!e.revoked && (
                <button onClick={() => void revoke(e)} disabled={busy === e.voice_id}
                  className={`font-jetbrains shrink-0 text-[11px] transition disabled:opacity-40 ${blocked ? "text-rose-300 hover:text-rose-200" : "text-white/50 hover:text-rose-300"}`}>
                  {busy === e.voice_id ? "revoking…" : blocked ? "delete voice" : "revoke"}
                </button>
              )}
            </li>
            );
          })}
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
