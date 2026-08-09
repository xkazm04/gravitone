"use client";

// What the speaker sees after the write lands. Both screens state the reach of
// what just happened — a record on both sides, honoured by this studio, not a
// lock on anyone's engine.

import Link from "next/link";
import { ErrorBanner } from "@/components/ui/ErrorBanner";

export function SignoffSigned({ mirrorWarning }: { mirrorWarning: boolean }) {
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

export function SignoffDeclined() {
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
