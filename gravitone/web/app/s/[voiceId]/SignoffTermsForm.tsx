"use client";

// The open request: what was cloned, the phrase read back, and the terms the
// speaker sets before granting. Refusing is offered right beside granting.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button } from "@/components/ui/Primitives";
import { signoffState, type VaultEntry } from "@/lib/voiceVault";
import PhraseRecorder from "./PhraseRecorder";

export const EXCLUSIONS = [
  "political content",
  "endorsements or advertising",
  "adult content",
  "impersonating me as myself",
];

export default function SignoffTermsForm({
  entry,
  purpose, setPurpose,
  expiresAt, setExpiresAt,
  exclusions, toggleExclusion,
  phraseSeconds, setPhraseSeconds,
  skipRecording, setSkipRecording,
  submitting, submitErr,
  grant, decline,
}: {
  entry: VaultEntry;
  purpose: string;
  setPurpose: (v: string) => void;
  expiresAt: string;
  setExpiresAt: (v: string) => void;
  exclusions: string[];
  toggleExclusion: (x: string) => void;
  phraseSeconds: number | null;
  setPhraseSeconds: (v: number | null) => void;
  skipRecording: boolean;
  setSkipRecording: (v: boolean) => void;
  submitting: "grant" | "decline" | null;
  submitErr: string | null;
  grant: () => Promise<void>;
  decline: () => Promise<void>;
}) {
  return (
    <>
      <div className="glass-panel mt-4 rounded-2xl p-5">
        <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">the request</div>
        <p className="mt-2 text-sm text-white/80">
          <span className="text-white">{entry.character_name} · {entry.emotion}</span>
        </p>
        <p className="font-jetbrains mt-1 text-[11px] text-white/50">
          cloned by {entry.consent?.attestedEmail ?? "an account on this box"} ·
          {" "}{entry.consent?.statement}
        </p>
        {signoffState(entry.consent?.signoff) === "declined" && (
          <p className="font-jetbrains mt-2 text-[11px] text-amber-200">
            you refused this before — signing now replaces that refusal
          </p>
        )}
      </div>

      <div className="mt-4">
        <PhraseRecorder
          phrase={entry.consent!.signoff!.phrase}
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
  );
}
