"use client";

// Voices of mine — the speaker side of the vault. Same vocabulary as MyVoices,
// opposite direction: every voice someone ELSE cloned from this person, under
// what scope, until when, with a withdraw per entry.
//
// A withdrawal stamps both the speaker's mirror and the owner's vault row, so
// the owner's list flips to "consent withdrawn — action required" and their
// existing delete path finishes the job. That is honest client-side
// enforcement, and the panel says exactly that rather than implying a lock.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useCallback, useEffect, useState } from "react";
import { relTime } from "@/app/voices/_variants/data";
import { useMounted } from "@/lib/useMounted";
import {
  listSpeakerConsents, signoffBadge, signoffState, withdrawConsent, type SpeakerConsent,
} from "@/lib/voiceVault";
import { SignoffBadgePill } from "./MyVoices";

/** A mirror row carries the same fields the badge reads, minus the status —
 *  a mirror only exists once it was signed. */
function stateOf(c: SpeakerConsent) {
  return signoffState({
    status: "signed", token: "", phrase: c.phrase,
    scope: c.scope, signedAt: c.signedAt, withdrawnAt: c.withdrawnAt,
  });
}

export default function VoicesOfMine({ uid }: { uid: string }) {
  const [entries, setEntries] = useState<SpeakerConsent[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mounted = useMounted();

  const refresh = useCallback(async () => {
    try {
      const list = await listSpeakerConsents(uid);
      if (!mounted.current) return;
      setEntries(list);
    } catch {
      // Never render the empty state on a read failure — that would tell a
      // speaker nobody cloned them when the truth is unknown.
      if (!mounted.current) return;
      setEntries([]);
      setErr("couldn't load the voices signed over to others — reload to retry");
    }
  }, [uid, mounted]);
  useEffect(() => { void refresh(); }, [refresh]);

  const withdraw = useCallback(async (c: SpeakerConsent) => {
    if (!window.confirm(
      `Withdraw consent for "${c.character_name} · ${c.emotion}"?\n\n` +
      "The owner's vault flips to \"consent withdrawn — action required\" and their studio stops " +
      "playing it. Enforcement is client-side in v1 — the engine cannot yet refuse them.",
    )) return;
    setBusy(c.voice_id);
    setErr(null);
    try {
      const { mirror, owner } = await withdrawConsent(uid, c);
      if (!mirror && !owner) throw new Error("the withdrawal could not be recorded — nothing changed");
      if (!owner) setErr("withdrawn on your side, but the owner's record could not be updated — they have not been told yet");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "withdraw failed");
      await refresh();
    } finally { setBusy(null); }
  }, [uid, refresh]);

  if (entries === null) {
    return <p className="font-jetbrains text-[12px] text-white/50">loading voices of mine…</p>;
  }

  const live = entries.filter((c) => !c.withdrawnAt).length;

  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="flex items-baseline justify-between">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          voices of mine — signed over
        </span>
        <span className="font-jetbrains text-[11px] text-white/45">
          {live} active · you are the speaker
        </span>
      </div>

      {err && <ErrorBanner className="mt-3">{err}</ErrorBanner>}

      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-white/60">
          Nobody has asked you to sign off a clone of your voice yet. When someone does, they send
          you a link — the grant they get lands here, with its scope and a withdraw button.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {entries.map((c) => {
            const state = stateOf(c);
            const dead = state === "withdrawn" || state === "expired";
            return (
              <li key={c.voice_id}
                className={`flex flex-wrap items-center gap-3 rounded-xl border border-white/8 bg-black/25 px-3 py-2 ${dead ? "opacity-50" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 truncate text-sm text-white">
                    {dead ? <s>{c.character_name} · {c.emotion}</s> : <>{c.character_name} · {c.emotion}</>}
                    <SignoffBadgePill badge={signoffBadge(state)} />
                  </div>
                  <div className="font-jetbrains truncate text-[11px] text-white/50">
                    cloned by {c.ownerEmail ?? c.ownerUid} · signed {relTime(c.signedAt)}
                    {c.scope?.expiresAt && ` · until ${c.scope.expiresAt}`}
                  </div>
                  {(c.scope?.purpose || c.scope?.exclusions?.length) && (
                    <div className="font-jetbrains mt-1 text-[11px] text-white/45">
                      {c.scope?.purpose && <>scope: {c.scope.purpose}</>}
                      {c.scope?.exclusions?.length ? ` · excluded: ${c.scope.exclusions.join(", ")}` : ""}
                    </div>
                  )}
                  {!c.scope?.purpose && !c.scope?.expiresAt && !c.scope?.exclusions?.length && (
                    <div className="font-jetbrains mt-1 text-[11px] text-white/45">
                      granted without limits — no purpose, no expiry, no exclusions
                    </div>
                  )}
                </div>
                {!dead && (
                  <button onClick={() => void withdraw(c)} disabled={busy === c.voice_id}
                    className="font-jetbrains shrink-0 text-[11px] text-white/50 transition hover:text-rose-300 disabled:opacity-40">
                    {busy === c.voice_id ? "withdrawing…" : "withdraw"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/40">
        Your grants, kept on your account. Withdrawal is honoured by this studio today; the engine
        has no identity yet, so v1 is an honest paper trail rather than a padlock.
      </p>
    </div>
  );
}
