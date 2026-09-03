"use client";

import type { Dispatch } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import type { Action } from "../_state/machine";
import { LIMITS_HINT } from "../_state/uploadLimits";
import type { Pending } from "../_state/useIngestActions";
import type { ProbeState } from "../_state/useLinkProbe";

/** The link door's input and its paste-time verdict. */
export default function VoiceNewLinkDoor({
  link, setLink, linkProbe, linkUsable, pending, dispatch, startLinkScan,
}: {
  link: string;
  setLink: (v: string) => void;
  linkProbe: ProbeState;
  linkUsable: boolean;
  pending: Pending;
  dispatch: Dispatch<Action>;
  startLinkScan: () => void;
}) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <label htmlFor="ingest-link" className="text-sm text-white">
        Paste a YouTube link
      </label>
      <input id="ingest-link" type="url" inputMode="url" value={link} spellCheck={false}
        placeholder="https://www.youtube.com/watch?v=…"
        onChange={(e) => { setLink(e.target.value); dispatch({ type: "SET_ERROR", error: null }); }}
        onKeyDown={(e) => { if (e.key === "Enter" && linkUsable && pending === null) { e.preventDefault(); void startLinkScan(); } }}
        className="font-jetbrains mt-2 w-full rounded-xl border border-white/12 bg-black/30 px-3 py-2 text-[13px] text-white outline-none transition placeholder:text-white/25 focus:border-cyan-400/50" />

      {/* THE VERDICT, before any media moves. Four states and not one
          of them is a spinner that ends nowhere:
            checking — we are asking, and say so
            done/ok  — what fits, and what will be cut if anything
            done/!ok — a link we read and refused, with the reason
            failed   — a link we could not read, with the fallback */}
      {linkProbe.status === "checking" && (
        <p className="font-jetbrains mt-3 text-[12px] text-white/50" aria-live="polite">
          checking that link…
        </p>
      )}
      {linkProbe.status === "done" && linkProbe.verdict.ok && (
        <div className={`mt-3 rounded-xl border px-3 py-2 ${linkProbe.verdict.trimmed ? "border-amber-400/30 bg-amber-400/5" : "border-emerald-400/25 bg-emerald-400/5"}`}
          aria-live="polite">
          <div className="text-[13px] text-white">{linkProbe.verdict.title}</div>
          <div className={`font-jetbrains mt-0.5 text-[12px] ${linkProbe.verdict.trimmed ? "text-amber-200" : "text-emerald-200"}`}>
            {linkProbe.verdict.message}
          </div>
        </div>
      )}
      {linkProbe.status === "done" && !linkProbe.verdict.ok && (
        <div className="mt-3">
          <ErrorBanner>{linkProbe.verdict.message}</ErrorBanner>
        </div>
      )}
      {linkProbe.status === "failed" && (
        <div className="mt-3">
          <ErrorBanner>{linkProbe.detail}</ErrorBanner>
        </div>
      )}

      {/* Said before the paste, not after the failure: this box
          fetches from YouTube only, and what it fetches is subject to
          the same caps a file is. */}
      <p className="font-jetbrains mt-2 max-w-2xl text-[11px] leading-relaxed text-white/45">
        youtube.com or youtu.be, one video (not a playlist or a live stream).
        The audio is fetched by the Gravitone box — {LIMITS_HINT}.
      </p>
      <p className="font-jetbrains mt-1 max-w-2xl text-[11px] leading-relaxed text-white/35">
        You will be asked to attest that you have the right to use the recording
        before anything is cloned.
      </p>
    </div>
  );
}
