"use client";

// The expanded half of the dock: the glass panel behind the pill. Purely
// presentational — it owns no state, sends nothing, and knows nothing about
// Firebase. It is handed a phase and a set of callbacks and draws them.

import type { RefObject } from "react";

import { MAX_MESSAGE_CHARS as FEEDBACK_MAX_CHARS } from "@/app/api/feedback/limits";
import { ErrorBanner } from "./ErrorBanner";

/** Show the counter only once the note is long enough for the cap to be real. */
const COUNTER_FROM = 1600;

export type Phase = "idle" | "sending" | "sent";

export function FeedbackDockPanel({
  areaRef,
  message,
  onMessage,
  phase,
  onCompose,
  onClose,
  onSend,
  canSend,
  tooLong,
  length,
  error,
}: {
  areaRef: RefObject<HTMLTextAreaElement | null>;
  message: string;
  onMessage: (value: string) => void;
  phase: Phase;
  /** "Send another" — back to an empty compose box, panel still open. */
  onCompose: () => void;
  onClose: () => void;
  onSend: () => void;
  canSend: boolean;
  tooLong: boolean;
  /** Length of the TRIMMED note — the same number the route will measure. */
  length: number;
  error: string | null;
}) {
  return (
    <section
      aria-label="Send feedback"
      className="glass-panel pointer-events-auto w-[min(22rem,calc(100vw-2rem))] rounded-3xl p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-jetbrains text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">
            Feedback
          </div>
          <h2 className="font-instrument mt-0.5 text-lg leading-tight text-white">
            Tell us what broke — or what should exist
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close feedback"
          className="shrink-0 cursor-pointer rounded-full border border-white/12 px-2 py-1 text-[12px] leading-none text-white/60 transition hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ✕
        </button>
      </div>

      {phase === "sent" ? (
        <div className="mt-3">
          <p className="font-hanken text-[13px] leading-snug text-slate-300">
            Filed. Thank you — it lands where we actually read it.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={onCompose}
              className="font-jetbrains cursor-pointer rounded-full border border-white/15 px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-white/85 transition hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Send another
            </button>
            <button
              type="button"
              onClick={onClose}
              className="font-jetbrains cursor-pointer px-2 py-2 text-[11px] uppercase tracking-[0.14em] text-white/40 transition hover:text-white/70 focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <textarea
            ref={areaRef}
            value={message}
            onChange={(e) => onMessage(e.target.value)}
            rows={4}
            maxLength={FEEDBACK_MAX_CHARS + 200}
            placeholder="The emotion picker didn't…"
            className="font-hanken mt-3 w-full resize-none rounded-2xl border border-white/8 bg-black/30 px-3 py-2.5 text-[13px] leading-snug text-white/85 placeholder:text-white/25 focus:border-cyan-400/40 focus:outline-none"
          />

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onSend()}
              disabled={!canSend}
              className="cursor-pointer rounded-full bg-gradient-to-r from-cyan-300 to-cyan-200 px-4 py-2 text-[12px] font-semibold text-slate-950 transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {phase === "sending" ? "Sending…" : "Send"}
            </button>
            <span
              className={`font-jetbrains ml-auto text-[10px] tabular-nums ${
                tooLong ? "text-rose-300" : "text-white/35"
              }`}
            >
              {length >= COUNTER_FROM ? `${length} / ${FEEDBACK_MAX_CHARS}` : ""}
            </span>
          </div>

          <p className="font-jetbrains mt-2 text-[10px] leading-relaxed text-white/30">
            Sent with your account and the page you are on.
          </p>

          <ErrorBanner className="mt-3">{error}</ErrorBanner>
        </>
      )}
    </section>
  );
}
