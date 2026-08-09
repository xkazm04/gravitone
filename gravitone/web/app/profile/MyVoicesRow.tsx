"use client";

// One vault row: playback, the consent line, the sign-off invite while it is
// pending, and the two ways a voice ends.

import Link from "next/link";
import { relTime } from "@/app/voices/_variants/data";
import {
  isConsentBlocked, signoffBadge, signoffLink, signoffState, type VaultEntry,
} from "@/lib/voiceVault";
import { SignoffBadgePill } from "./ProfileSignoffBadge";

const METHOD_LABEL: Record<string, string> = {
  "self-recorded": "self-recorded",
  uploaded: "uploaded · consent attested",
  ingested: "from recording · consent attested",
};

export default function MyVoicesRow({
  e,
  uid,
  preview,
  playingId,
  busyId,
  copy,
  copied,
  failed,
  asking,
  onAsk,
  busy,
  onRevoke,
}: {
  e: VaultEntry;
  uid: string;
  preview: (voiceId: string, label: string) => void;
  playingId: string | null;
  busyId: string | null;
  copy: (text: string, key: string) => void;
  copied: string | null;
  failed: string | null;
  asking: string | null;
  onAsk: () => void;
  busy: string | null;
  onRevoke: () => void;
}) {
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
    <li
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
        <button onClick={onAsk} disabled={asking === e.voice_id}
          className="font-jetbrains shrink-0 text-[11px] text-cyan-300/80 transition hover:text-cyan-200 disabled:opacity-40">
          {asking === e.voice_id ? "creating…" : "request sign-off"}
        </button>
      )}
      {!e.revoked && (state === "declined" || blocked) && (
        <button onClick={onAsk} disabled={asking === e.voice_id}
          className="font-jetbrains shrink-0 text-[11px] text-white/50 transition hover:text-cyan-200 disabled:opacity-40">
          {asking === e.voice_id ? "creating…" : "ask again"}
        </button>
      )}
      {!e.revoked && (
        <button onClick={onRevoke} disabled={busy === e.voice_id}
          className={`font-jetbrains shrink-0 text-[11px] transition disabled:opacity-40 ${blocked ? "text-rose-300 hover:text-rose-200" : "text-white/50 hover:text-rose-300"}`}>
          {busy === e.voice_id ? "revoking…" : blocked ? "delete voice" : "revoke"}
        </button>
      )}
    </li>
  );
}
