"use client";

// /s/{voiceId}?o={ownerUid}&k={token} — the speaker's side of a clone.
//
// Order matters: the link is a secret, so nothing about the owner or the voice
// is shown until BOTH halves check out (a valid record for that owner AND a
// token match). Playback is the one thing offered before sign-in, because the
// voice id is already in the link and hearing yourself cloned is the whole
// reason to bother signing in.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useVoicePreview } from "@/app/voices/_variants/data";
import { useAuth } from "@/lib/useAuth";
import { useMounted } from "@/lib/useMounted";
import { Button } from "@/components/ui/Primitives";
import {
  declineSignoff, grantSignoff, loadVaultEntry, signoffState, tokenMatches,
  type SignoffScope, type VaultEntry,
} from "@/lib/voiceVault";
import PhraseRecorder from "./PhraseRecorder";

export const EXCLUSIONS = [
  "political content",
  "endorsements or advertising",
  "adult content",
  "impersonating me as myself",
];

type Gate =
  | { kind: "link-incomplete" }
  | { kind: "signin" }
  | { kind: "loading" }
  | { kind: "unreadable"; message: string }
  | { kind: "invalid" }
  | { kind: "grant"; entry: VaultEntry }
  | { kind: "settled"; entry: VaultEntry };

export default function SignoffFlow({
  voiceId, ownerUid, token,
}: { voiceId: string; ownerUid: string | null; token: string | null }) {
  const { user, loading, ready, authResolved, signIn } = useAuth();
  const mounted = useMounted();
  const { preview, playingId, busyId, failedId, failedReason } = useVoicePreview();

  const [entry, setEntry] = useState<VaultEntry | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [purpose, setPurpose] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [phraseSeconds, setPhraseSeconds] = useState<number | null>(null);
  const [skipRecording, setSkipRecording] = useState(false);
  const [submitting, setSubmitting] = useState<"grant" | "decline" | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"signed" | "declined" | null>(null);
  const [mirrorWarning, setMirrorWarning] = useState(false);

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

  const toggleExclusion = useCallback((x: string) => {
    setExclusions((prev) => (prev.includes(x) ? prev.filter((p) => p !== x) : [...prev, x]));
  }, []);

  const grant = useCallback(async () => {
    if (!user || !ownerUid || !entry) return;
    setSubmitting("grant");
    setSubmitErr(null);
    try {
      const scope: SignoffScope = {};
      if (purpose.trim()) scope.purpose = purpose.trim();
      if (expiresAt) scope.expiresAt = expiresAt;
      if (exclusions.length) scope.exclusions = exclusions;
      const res = await grantSignoff({
        ownerUid, entry, speaker: { uid: user.uid, email: user.email },
        scope, phraseRecorded: phraseSeconds != null,
        ...(phraseSeconds != null ? { phraseSeconds } : {}),
      });
      if (!mounted.current) return;
      setMirrorWarning(!res.mirror);
      setOutcome("signed");
    } catch (e) {
      if (!mounted.current) return;
      setSubmitErr(e instanceof Error
        ? `your sign-off was NOT recorded (${e.message}) — nothing was granted`
        : "your sign-off was NOT recorded — nothing was granted");
    } finally {
      if (mounted.current) setSubmitting(null);
    }
  }, [user, ownerUid, entry, purpose, expiresAt, exclusions, phraseSeconds, mounted]);

  const decline = useCallback(async () => {
    if (!user || !ownerUid || !entry) return;
    setSubmitting("decline");
    setSubmitErr(null);
    try {
      await declineSignoff(ownerUid, entry, { uid: user.uid, email: user.email });
      if (!mounted.current) return;
      setOutcome("declined");
    } catch (e) {
      if (!mounted.current) return;
      setSubmitErr(e instanceof Error ? `the refusal was not recorded (${e.message})` : "the refusal was not recorded");
    } finally {
      if (mounted.current) setSubmitting(null);
    }
  }, [user, ownerUid, entry, mounted]);

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
    return (
      <div className="glass-panel mt-6 rounded-2xl p-6">
        <h2 className="font-instrument text-2xl text-white">Signed.</h2>
        <p className="mt-3 text-sm text-white/70">
          Your consent is recorded on both sides: the owner&apos;s vault carries a
          <span className="text-emerald-200"> speaker-signed</span> badge, and your own profile now
          lists this voice under &quot;voices of mine&quot; — with a withdraw button that stays there.
        </p>
        {mirrorWarning && (
          <ErrorBanner className="mt-3">
            the owner&apos;s record was updated, but your personal copy could not be written — your
            profile may not list this voice until you reload
          </ErrorBanner>
        )}
        <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/45">
          Enforcement is client-side in v1: this studio honours your scope and any withdrawal, but
          the synthesis engine has no identity yet and cannot refuse a request on its own.
        </p>
        <Link href="/profile" className="font-jetbrains mt-4 inline-block text-[12px] text-cyan-300 hover:text-cyan-200">
          go to my profile →
        </Link>
      </div>
    );
  }

  if (outcome === "declined") {
    return (
      <div className="glass-panel mt-6 rounded-2xl p-6">
        <h2 className="font-instrument text-2xl text-white">Declined.</h2>
        <p className="mt-3 text-sm text-white/70">
          The owner&apos;s record now says you refused. Nothing was granted. Because enforcement is
          client-side in v1, this is a record and a strong signal — not a technical block on their
          engine.
        </p>
      </div>
    );
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
            <>
              <div className="glass-panel mt-4 rounded-2xl p-5">
                <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">the request</div>
                <p className="mt-2 text-sm text-white/80">
                  <span className="text-white">{gate.entry.character_name} · {gate.entry.emotion}</span>
                </p>
                <p className="font-jetbrains mt-1 text-[11px] text-white/50">
                  cloned by {gate.entry.consent?.attestedEmail ?? "an account on this box"} ·
                  {" "}{gate.entry.consent?.statement}
                </p>
                {signoffState(gate.entry.consent?.signoff) === "declined" && (
                  <p className="font-jetbrains mt-2 text-[11px] text-amber-200">
                    you refused this before — signing now replaces that refusal
                  </p>
                )}
              </div>

              <div className="mt-4">
                <PhraseRecorder
                  phrase={gate.entry.consent!.signoff!.phrase}
                  onRecorded={setPhraseSeconds}
                />
              </div>

              <div className="glass-panel mt-4 rounded-2xl p-5">
                <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">your terms</div>

                <label className="mt-3 block">
                  <span className="font-jetbrains text-[11px] text-white/55">what may this voice be used for?</span>
                  <input value={purpose} onChange={(e) => setPurpose(e.target.value)}
                    placeholder="e.g. the narration for their documentary, nothing else"
                    className="font-hanken mt-1 w-full rounded-xl border border-white/12 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-cyan-400/40 focus:outline-none" />
                </label>

                <label className="mt-3 block">
                  <span className="font-jetbrains text-[11px] text-white/55">consent expires (optional)</span>
                  <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
                    className="font-jetbrains mt-1 block rounded-xl border border-white/12 bg-white/[0.03] px-3 py-2 text-sm text-white focus:border-cyan-400/40 focus:outline-none" />
                </label>

                <fieldset className="mt-4">
                  <legend className="font-jetbrains text-[11px] text-white/55">never for</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {EXCLUSIONS.map((x) => (
                      <button key={x} type="button" onClick={() => toggleExclusion(x)}
                        aria-pressed={exclusions.includes(x)}
                        className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1 text-[11px] transition ${
                          exclusions.includes(x)
                            ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
                            : "border-white/12 text-white/60 hover:text-white"
                        }`}>
                        {x}
                      </button>
                    ))}
                  </div>
                </fieldset>

                {!purpose.trim() && !expiresAt && exclusions.length === 0 && (
                  <p className="font-jetbrains mt-3 text-[11px] text-amber-200">
                    no terms set — this would grant unlimited use with no expiry
                  </p>
                )}

                {submitErr && <ErrorBanner className="mt-3">{submitErr}</ErrorBanner>}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    onClick={() => void grant()}
                    disabled={submitting !== null || (phraseSeconds == null && !skipRecording)}
                    className="cursor-pointer"
                  >
                    {submitting === "grant" ? "recording your consent…" : "Sign off — this is my voice"}
                  </Button>
                  <button onClick={() => void decline()} disabled={submitting !== null}
                    className="font-jetbrains cursor-pointer text-[12px] text-white/60 transition hover:text-rose-300 disabled:opacity-40">
                    {submitting === "decline" ? "recording…" : "this is not my voice — refuse"}
                  </button>
                </div>

                {phraseSeconds == null && (
                  <label className="font-jetbrains mt-3 flex items-center gap-2 text-[11px] text-white/50">
                    <input type="checkbox" checked={skipRecording} onChange={(e) => setSkipRecording(e.target.checked)} />
                    my microphone will not work — sign without reading the phrase (the record will
                    say so)
                  </label>
                )}

                <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/40">
                  Enforcement is client-side in v1. Your scope, expiry and any later withdrawal are
                  honoured by this studio and travel with the voice&apos;s record — but the synthesis
                  engine has no identity yet, so this is a signed agreement rather than a lock.
                </p>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
