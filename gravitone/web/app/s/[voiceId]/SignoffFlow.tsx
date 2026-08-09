"use client";

// /s/{voiceId}?o={ownerUid}&k={token} — the speaker's side of a clone.
//
// Order matters: the link is a secret, so nothing about the owner or the voice
// is shown until BOTH halves check out (a valid record for that owner AND a
// token match). Playback is the one thing offered before sign-in, because the
// voice id is already in the link and hearing yourself cloned is the whole
// reason to bother signing in.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import Link from "next/link";
import { useVoicePreview } from "@/app/voices/_variants/data";
import { Button } from "@/components/ui/Primitives";
import { signoffState } from "@/lib/voiceVault";
import { SignoffDeclined, SignoffSigned } from "./SignoffOutcome";
import SignoffTermsForm from "./SignoffTermsForm";
import { useSignoffGate } from "./useSignoffGate";
import { useSignoffSubmit } from "./useSignoffSubmit";

export { EXCLUSIONS } from "./SignoffTermsForm";

export default function SignoffFlow({
  voiceId, ownerUid, token,
}: { voiceId: string; ownerUid: string | null; token: string | null }) {
  const { gate, entry, user, ready, signIn } = useSignoffGate({ voiceId, ownerUid, token });
  const { preview, playingId, busyId, failedId, failedReason } = useVoicePreview();
  const submit = useSignoffSubmit({ user, ownerUid, entry });
  const { outcome, mirrorWarning } = submit;

  const hear = (
    <div className="glass-panel mt-6 rounded-2xl p-5">
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">hear the clone</div>
      <p className="mt-2 text-sm text-white/70">
        Play the cloned voice before you decide anything. No account needed for this part.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => void preview(voiceId, "this voice")}
          disabled={busyId === voiceId}
          aria-label="Play the cloned voice"
          className="grid h-10 w-10 place-items-center rounded-full bg-cyan-300 text-[13px] text-slate-950 transition hover:brightness-110 disabled:opacity-40"
        >
          {busyId === voiceId ? "…" : playingId === voiceId ? "⏸" : "▶"}
        </button>
        <span className="font-jetbrains text-[12px] text-white/50">
          {failedId === voiceId ? (failedReason ?? "preview failed") : "a sample line, synthesized now"}
        </span>
      </div>
    </div>
  );

  if (outcome === "signed") {
    return <SignoffSigned mirrorWarning={mirrorWarning} />;
  }

  if (outcome === "declined") {
    return <SignoffDeclined />;
  }

  return (
    <div>
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">speaker sign-off</div>
      <h1 className="font-instrument mt-3 text-4xl text-white">Is this your voice?</h1>
      <p className="mt-3 text-sm leading-relaxed text-white/70">
        Someone cloned a voice and is asking the person behind it to sign off. If that is you, you
        decide the terms — and you keep a dashboard with a withdraw button afterwards.
      </p>

      {gate.kind === "link-incomplete" ? (
        <div className="glass-panel mt-6 rounded-2xl p-5">
          <p className="text-sm text-white/70">
            This link is incomplete. A sign-off link carries the voice, the owner and a one-off
            token — ask whoever sent it to copy the whole thing.
          </p>
        </div>
      ) : (
        <>
          {hear}

          {gate.kind === "loading" && (
            <p className="font-jetbrains mt-6 text-[12px] text-white/50">checking the request…</p>
          )}

          {gate.kind === "signin" && (
            <div className="glass-panel mt-4 rounded-2xl p-5">
              <p className="text-sm text-white/70">
                Sign in as yourself to see who cloned this voice and to grant or refuse. Your
                account is what makes the record a two-party one.
              </p>
              {!ready && (
                <p className="font-jetbrains mt-2 text-[11px] text-amber-200">
                  sign-in is unavailable on this deployment (Firebase is not configured) — sign-off
                  cannot be recorded here
                </p>
              )}
              <Button className="mt-4 cursor-pointer" onClick={() => void signIn()} disabled={!ready}>
                Sign in with Google
              </Button>
            </div>
          )}

          {gate.kind === "unreadable" && (
            <ErrorBanner className="mt-4">
              this request could not be read ({gate.message}) — reload, or ask the owner for a fresh link
            </ErrorBanner>
          )}

          {gate.kind === "invalid" && (
            <div className="glass-panel mt-4 rounded-2xl p-5">
              <p className="text-sm text-white/70">
                This sign-off link is not valid — it may have been replaced by a newer request, or
                copied incompletely. Ask the owner to send the current one. Nothing about their
                account is shown here.
              </p>
            </div>
          )}

          {gate.kind === "settled" && (
            <div className="glass-panel mt-4 rounded-2xl p-5">
              <p className="text-sm text-white/70">
                {signoffState(gate.entry.consent?.signoff) === "signed"
                  ? "This clone is already signed off. If it was you, it is listed on your profile under \"voices of mine\", with a withdraw button."
                  : "This request is no longer open — the consent was withdrawn or has expired. Ask the owner for a fresh request."}
              </p>
              <Link href="/profile" className="font-jetbrains mt-3 inline-block text-[12px] text-cyan-300 hover:text-cyan-200">
                my profile →
              </Link>
            </div>
          )}

          {gate.kind === "grant" && (
            <SignoffTermsForm
              entry={gate.entry}
              purpose={submit.purpose}
              setPurpose={submit.setPurpose}
              expiresAt={submit.expiresAt}
              setExpiresAt={submit.setExpiresAt}
              exclusions={submit.exclusions}
              toggleExclusion={submit.toggleExclusion}
              phraseSeconds={submit.phraseSeconds}
              setPhraseSeconds={submit.setPhraseSeconds}
              skipRecording={submit.skipRecording}
              setSkipRecording={submit.setSkipRecording}
              submitting={submit.submitting}
              submitErr={submit.submitErr}
              grant={submit.grant}
              decline={submit.decline}
            />
          )}
        </>
      )}
    </div>
  );
}
