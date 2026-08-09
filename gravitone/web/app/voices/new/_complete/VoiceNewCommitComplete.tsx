"use client";

import Link from "next/link";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import { corpusNotice } from "../_state/corpus";
import type { Created, Job, Result, State } from "../_state/machine";

/** The completion screen for a single-speaker commit. */
export default function VoiceNewCommitComplete({
  job, result, created, committedCid, fromCid, pendingCommit, vaultWarn, scanAnother,
}: {
  job: Job | null;
  result: Result | null;
  created: Created[];
  committedCid: string | null;
  fromCid: string | null;
  pendingCommit: State["pendingCommit"];
  vaultWarn: boolean;
  scanAnother: () => void;
}) {
  return (
    <div className="mt-8 max-w-3xl">
      <div className="glass-panel rounded-2xl p-5">
        <div className="font-jetbrains text-[11px] uppercase tracking-widest text-emerald-300">character ready</div>
        <h2 className="font-instrument mt-2 text-3xl text-white">{created.length} voices cloned.</h2>
        {/* A pick that could not be honoured is STATED: the voice exists,
            but it is not the take the user chose, and only the backend
            knows that. Silence here would be the flow claiming the
            audition mattered when it did not. */}
        {(job?.recipes?.skipped?.length ?? 0) > 0 && (
          <p className="font-jetbrains mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/85">
            {job!.recipes!.skipped.map((s) => (
              <span key={`${s.emotion}-${s.recipe}`} className="block">
                {emotionMeta(s.emotion).label}: the take you picked wasn&apos;t used — {s.why}.
                The full stem was cloned instead.
              </span>
            ))}
          </p>
        )}
        {vaultWarn && (
          <p className="font-jetbrains mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/85">
            Voices cloned, but the consent receipt couldn’t be saved to your vault. Reload “My Voices” — if they’re missing, re-open the character to re-record ownership.
          </p>
        )}
        {/* What this box did with the RECORDING, as the service reported
            it — always stated, including the "nothing was kept" case,
            which is quiet rather than absent: on a page about someone's
            voice, "we kept nothing" is worth one line, and silence is the
            one thing indistinguishable from a capture that failed. */}
        {(() => {
          const notice = corpusNotice(job?.corpus);
          if (!notice) return null;
          if (notice.tone === "quiet") {
            return (
              <p className="font-jetbrains mt-3 text-[11px] text-white/40">{notice.text}</p>
            );
          }
          if (notice.tone === "warning") {
            return <ErrorBanner severity="warning" className="mt-3">{notice.text}</ErrorBanner>;
          }
          return (
            <p className="font-jetbrains mt-3 rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-[11px] leading-relaxed text-emerald-200/85">
              🔒 {notice.text}
            </p>
          );
        })()}
        {/* Eviction is a deletion the user did not ask for, so it is named
            with the service's own reason for each clip it took. */}
        {(job?.corpus?.pruned?.length ?? 0) > 0 && (
          <p className="font-jetbrains mt-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/85">
            {job!.corpus!.pruned!.map((p) => (
              <span key={p.clip_sha256} className="block">
                an older recording was removed to make room — {p.why}.
              </span>
            ))}
          </p>
        )}
        {/* Each created Voice with the number measured ON IT: the clone is
            synthesized and scored against the speaker's own reference at
            commit, and this screen showed emotion names only. Where there
            is no number the backend said why, and that sentence is carried
            rather than an empty chip the user has to interpret. */}
        <div className="mt-4 flex flex-wrap gap-2">
          {created.map((c) => {
            const m = emotionMeta(c.emotion);
            const measured = typeof c.identity === "number";
            return (
              <span key={c.voice_id}
                title={measured
                  ? "Identity match: how closely the cloned voice sounds like the "
                    + "speaker it was made from (1.00 is identical). It says nothing "
                    + "about whether the take is good."
                  : c.identity_reason
                    ? `Identity was not measured — ${c.identity_reason}`
                    : undefined}
                className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] text-white/80">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${m.hue} 80% 62%)` }} />{m.label}
                {measured && (
                  <span className="tabular-nums text-cyan-200/85">identity {c.identity!.toFixed(2)}</span>
                )}
                {!measured && c.identity_reason && (
                  <span className="text-white/40">not measured</span>
                )}
              </span>
            );
          })}
        </div>
        {/* Why a number is missing, once — the reason is the same for every
            voice in a commit (it is decided before the model loads), so it
            is stated once rather than repeated per chip. */}
        {created.some((c) => typeof c.identity !== "number" && c.identity_reason) && (
          <p className="font-jetbrains mt-2 text-[11px] leading-relaxed text-white/40">
            identity was not measured — {created.find((c) => c.identity_reason)!.identity_reason}.
          </p>
        )}
        {/* An extend-mode commit that OVERWROTE a voice used to say nothing
            at all. The previous embedding is gone by the time the row is
            swapped, so this is not a footnote — it is the outcome. */}
        {created.some((c) => c.replaced) && (
          <p className="font-jetbrains mt-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/85">
            {created.filter((c) => c.replaced).map((c) => (
              <span key={c.voice_id} className="block">
                replaced the previous {emotionMeta(c.emotion).label} voice
                {" "}({c.replaced}) — that embedding is gone.
              </span>
            ))}
          </p>
        )}
        {/* Coverage Coach — the recording produced an incomplete rack;
            give every remaining slot a direct path to done. Stems that
            were detected but too short to clone are called out. */}
        {committedCid && (() => {
          const done = new Set(created.map((c) => c.emotion));
          const missing = EMOTION_IDS.filter((e) => !done.has(e));
          if (missing.length === 0) return null;
          const shortStems = new Set(
            (result?.stems ?? []).filter((s) => !s.eligible).map((s) => s.emotion),
          );
          return (
            <div className="mt-6 rounded-2xl border border-amber-400/15 bg-amber-400/[0.04] p-5">
              <div className="font-jetbrains text-[11px] uppercase tracking-widest text-amber-200/80">
                coverage coach · {done.size}/{EMOTION_IDS.length} recorded
              </div>
              <p className="mt-1 text-sm text-white/65">
                Finish the rack with a guided 30-second read per emotion — no new recording to hunt for:
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {missing.map((e) => (
                  <Link
                    key={e}
                    href={`/voices/${committedCid}?record=${e}`}
                    className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-black/30 px-2.5 py-1 text-[11px] text-amber-200/90 transition hover:border-amber-300/50 hover:text-amber-100"
                  >
                    ● {emotionMeta(e).label}
                    {shortStems.has(e) && <span className="text-white/45">(detected, too short)</span>}
                  </Link>
                ))}
              </div>
            </div>
          );
        })()}

        <div className="mt-6 flex flex-wrap gap-3">
          {/* The loop closes here. When the flow was opened FROM a
              character, the primary action names that character by the
              name it was committed under — not "Open character", which
              reads as somewhere new. Deliberately a click and not an
              automatic redirect: this screen carries the skipped-take and
              consent-receipt warnings above, and a redirect would throw
              them away before they were read. */}
          {committedCid && (
            <Link href={`/voices/${committedCid}`} className="rounded-full bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110">
              {fromCid === committedCid && pendingCommit?.character
                ? `Back to ${pendingCommit.character} →`
                : "Open character →"}
            </Link>
          )}
          <button onClick={scanAnother} className="font-jetbrains cursor-pointer rounded-full border border-white/15 px-5 py-2.5 text-sm text-white/85 transition hover:bg-white/5">Scan another recording (extend palette)</button>
          <Link href="/voices" className="font-jetbrains rounded-full px-5 py-2.5 text-sm text-white/60 transition hover:text-white">Back to roster</Link>
        </div>
      </div>
    </div>
  );
}
