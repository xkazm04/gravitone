"use client";

// THE NOTICE STACK — every sentence the console says about itself, in the one
// order it says them. Gathered here because their ORDER and their SEVERITIES
// are the contract (web/DESIGN.md "honest failure surfaces"): rose means
// nothing was produced, amber means it was produced and is degraded, and the
// engine notice stands down whenever a fallback notice already reports the
// outcome.

import Link from "next/link";
import { ErrorBanner } from "@/components/ui/ErrorBanner";

export function PlaygroundNotices({
  newKeyPrefix, onDismissKey,
  rosterErr, fallbackNotice, storageErr, composerErr,
  composerNotice, onDismissComposerNotice,
  shareErr, onDismissShareErr,
  busyNotice, retryIn, busy, onRetry,
  engineNotice, healthStale,
  toast, onDismissToast,
}: {
  newKeyPrefix: string | null; onDismissKey: () => void;
  rosterErr: string | null;
  fallbackNotice: string | null | false;
  storageErr: string | null;
  composerErr: string | null;
  composerNotice: string | null; onDismissComposerNotice: () => void;
  shareErr: string | null; onDismissShareErr: () => void;
  busyNotice: { retryAfterSec: number } | null; retryIn: number; busy: boolean; onRetry: () => void;
  engineNotice: string | null; healthStale: boolean;
  toast: string | null; onDismissToast: () => void;
}) {
  return (
    <>
      {/* First sign-in also provisioned an API key. It is an aside — the
          Character and the line above are already loaded and the point of this
          screen is to press Generate. */}
      {newKeyPrefix && (
        <p className="font-jetbrains mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-4 py-2 text-[11px] text-cyan-200/90">
          <span>
            Welcome. You also got an API key (<span className="text-white/85">{newKeyPrefix}…</span>) for the
            ElevenLabs-compatible endpoints — it is on your profile whenever you want it.
          </span>
          <span className="flex shrink-0 items-center gap-3">
            <Link href="/profile" className="underline underline-offset-2 transition hover:text-cyan-100">profile →</Link>
            <button onClick={onDismissKey} aria-label="Dismiss" className="cursor-pointer text-cyan-200/60 transition hover:text-cyan-100">✕</button>
          </span>
        </p>
      )}

      {rosterErr && <ErrorBanner>{rosterErr}</ErrorBanner>}

      {/* The take exists but is degraded → warning (amber). */}
      {fallbackNotice && <ErrorBanner severity="warning">{fallbackNotice}</ErrorBanner>}

      {storageErr && <ErrorBanner severity="warning">{storageErr}</ErrorBanner>}

      {/* The composer is not durable right now — say so while there is still
          time to copy the text out. */}
      {composerErr && <ErrorBanner severity="warning">{composerErr}</ErrorBanner>}

      {/* Restored (or reused) work that had to be repaired: a Character it
          named is gone. Dismissible — it is about one action, not a state. */}
      {composerNotice && (
        <ErrorBanner severity="warning">
          <span className="flex items-center justify-between gap-3">
            <span>{composerNotice}</span>
            <button onClick={onDismissComposerNotice} aria-label="Dismiss" className="shrink-0 text-amber-200/70 transition hover:text-amber-100">✕</button>
          </span>
        </ErrorBanner>
      )}

      {/* Publishing failed: nothing was created, so this is an error, not a
          degraded success. */}
      {shareErr && (
        <ErrorBanner>
          <span className="flex items-center justify-between gap-3">
            <span>{shareErr}</span>
            <button onClick={onDismissShareErr} aria-label="Dismiss" className="shrink-0 text-rose-200/70 transition hover:text-rose-100">✕</button>
          </span>
        </ErrorBanner>
      )}

      {busyNotice && (
        <ErrorBanner severity="warning">
          <span className="flex flex-wrap items-center justify-between gap-3">
            <span>
              Engine busy — the render queue is full.{" "}
              {retryIn > 0 ? `The backend asked for ${retryIn}s before the next attempt.` : "You can retry now."}
            </span>
            {/* Retrying inside the backend's own Retry-After window just adds
                another rejection to the same full queue. */}
            <button
              onClick={onRetry}
              disabled={busy || retryIn > 0}
              title={retryIn > 0 ? `The backend asked for ${retryIn}s more` : "Retry this generation"}
              className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-amber-100 transition hover:bg-amber-400/20 disabled:opacity-40"
            >
              {busy ? "retrying…" : retryIn > 0 ? `↻ retry in ${retryIn}s` : "↻ retry"}
            </button>
          </span>
        </ErrorBanner>
      )}

      {/* Engine state the user should know BEFORE pressing Generate. Suppressed
          while a fallback notice is up — that one already reports the outcome. */}
      {!fallbackNotice && engineNotice && (
        <ErrorBanner severity="warning">
          {engineNotice}
          {healthStale && " (engine status may be out of date — the studio cannot reach it right now.)"}
        </ErrorBanner>
      )}

      {/* Nothing was produced → error (rose). */}
      {toast && (
        <ErrorBanner>
          <span className="flex items-center justify-between gap-3">
            <span>{toast}</span>
            <button onClick={onDismissToast} aria-label="Dismiss" className="shrink-0 text-rose-200/70 transition hover:text-rose-100">✕</button>
          </span>
        </ErrorBanner>
      )}
    </>
  );
}
