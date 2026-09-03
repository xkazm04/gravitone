"use client";

// The ledger's posture strip — the one measurement that says whether the keys
// below enforce anything, plus the cost of the root key that makes them do so.

import type { Posture } from "./probes";
import { relTime } from "./data";

export const Code = ({ children }: { children: string }) => (
  <span className="font-jetbrains text-cyan-200/90">{children}</span>
);

/** What setting a root key COSTS, stated where the operator would act on it.
 *  Both consequences are real and neither is obvious from this page. */
export function RootKeyConsequences() {
  return (
    <>
      Setting it also takes <Code>/docs</Code>, <Code>/redoc</Code> and <Code>/openapi.json</Code> offline
      (<Code>TTS_DOCS=on</Code> keeps them published), and puts <Code>/metrics</Code> — plus the engine
      config and latency percentiles on <Code>/health</Code> — behind the <Code>tts</Code> scope.
    </>
  );
}

/** The posture strip — no longer a guess.
 *
 *  This page used to say "can't tell from here", and it was telling the truth:
 *  every request went through the studio's proxy, which attaches its own root
 *  key, so an enforcing backend and a wide-open one answered identically. The
 *  probe route (`/api/keys/probe`) makes the one measurement that separates
 *  them — an UNAUTHENTICATED request, sent server-side with no credential at
 *  all — and this strip reports what came back:
 *
 *    open        the deployment served a request carrying no key. The keys
 *                below enforce NOTHING. This is the loudest thing on the page.
 *    enforced    the deployment refused it. Only TTS_API_KEY does that.
 *    unreachable nothing answered — no posture is claimed for a silent box.
 *    unmeasured  the probe has not answered yet. Not reassurance; absence. */
export default function PostureNote({ state, checkedAt }: { state: Posture; checkedAt: string | null }) {
  if (state === "unreachable") return null; // the error banner already says it
  if (state === "unmeasured") {
    return (
      <p className="font-jetbrains mt-4 text-[11px] text-white/45">
        Measuring key enforcement — sending one unauthenticated request to your deployment…
      </p>
    );
  }
  const when = checkedAt ? ` Probed ${relTime(checkedAt)}.` : "";
  if (state === "open") {
    return (
      <div role="alert" className="mt-4 rounded-xl border border-rose-400/40 bg-rose-400/10 px-4 py-3">
        <p className="font-jetbrains text-[11px] uppercase tracking-widest text-rose-300">
          this deployment is open to everyone
        </p>
        <p className="font-hanken mt-2 text-sm text-rose-100/90">
          A request carrying <strong className="font-semibold">no key at all</strong> was served. Every key below
          enforces nothing — anyone who can reach this host can synthesize, clone and manage voices on it. Set{" "}
          <Code>TTS_API_KEY</Code> on the box and restart; until then the ledger is a list of names, not access
          control.{when}
        </p>
        <p className="font-jetbrains mt-2 text-[10px] leading-relaxed text-rose-100/70">
          <RootKeyConsequences />
        </p>
      </div>
    );
  }
  return (
    <p className="font-jetbrains mt-4 rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-4 py-2 text-[11px] text-cyan-200/90">
      Key enforcement is <strong className="font-semibold">ON</strong> — an unauthenticated request to this
      backend was refused, which only a configured <Code>TTS_API_KEY</Code> does, so the keys below really do
      gate access.{when} If this page cannot load keys, <Code>GRAVITONE_API_KEY</Code> in the studio&apos;s
      environment does not hold a key the backend accepts. <RootKeyConsequences />
    </p>
  );
}
