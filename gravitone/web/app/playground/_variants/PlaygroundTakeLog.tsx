"use client";

// THE TAKE LOG — the header (compare selection, publish consent, count), the
// review link it can mint, the taught empty state, and the animated list of
// cards.
//
// The "rendering" row is handed in as a NODE rather than as ten props: it owns
// its own clock and must keep owning it, and the log has no business knowing
// what an ETA basis is.

import type { ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import type { Take } from "./playgroundHelpers";
// The playground's Signal accents — the restrained tier of web/DESIGN.md.
import { EmptyTakes } from "./signal";
import { PlaygroundTakeCard, type PlaygroundTakeCardShared } from "./PlaygroundTakeCard";

export function PlaygroundTakeLog({
  takes, busy, still, card,
  reviewSel, reviewBusy, reviewUrl, reviewErr, createReview,
  allowReperform, setAllowReperform, copy, copied, copyFailed,
  renderStatus,
}: {
  takes: Take[];
  busy: boolean;
  still: boolean;
  /** Everything a card needs that does not vary between cards. */
  card: PlaygroundTakeCardShared;
  reviewSel: Set<string>;
  reviewBusy: boolean;
  reviewUrl: string | null;
  reviewErr: string | null;
  createReview: () => void;
  allowReperform: boolean;
  setAllowReperform: (v: boolean) => void;
  copy: (value: string, key: string) => Promise<void> | void;
  copied: string | null;
  copyFailed: string | null;
  renderStatus: ReactNode;
}) {
  return (
    <div className="mt-8">
      <div className="font-jetbrains mb-3 flex flex-wrap items-center justify-between gap-3 text-[11px] uppercase tracking-widest text-white/60">
        <span>takes</span>
        <div className="flex flex-wrap items-center gap-3">
          {reviewSel.size > 0 && (
            <>
              <span className="text-cyan-300">{reviewSel.size} selected</span>
              <button
                onClick={() => void createReview()}
                disabled={reviewSel.size < 2 || reviewBusy}
                title={reviewSel.size < 2 ? "Select at least 2 takes to compare" : "Create a no-login link where a client picks the winner"}
                className="cursor-pointer rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-[11px] normal-case tracking-normal text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
              >
                {reviewBusy ? "creating…" : "→ client review link"}
              </button>
            </>
          )}
          {/* Publish-time consent for public re-perform. OFF by default and
              deliberately so: a fork puts NEW WORDS in this Character's
              voice and spends the box's CPU for a stranger. */}
          <label className="flex cursor-pointer items-center gap-2 normal-case tracking-normal text-white/55"
            title="Let visitors edit the text on the share page and re-render it in this Character's voice (rate-limited, and their fork cannot be forked again)">
            <input type="checkbox" checked={allowReperform}
              onChange={(e) => setAllowReperform(e.target.checked)}
              className="h-3 w-3 accent-cyan-300" />
            allow re-perform <span className="text-white/35">(visitors can re-render new words in this voice)</span>
          </label>
          <span>{takes.length}</span>
        </div>
      </div>

      {reviewUrl && (
        <p className="font-jetbrains mb-3 rounded-lg border border-emerald-400/25 bg-emerald-400/5 px-4 py-2 text-[11px] text-emerald-200/90">
          {/* The link is created either way; only the CLIPBOARD's outcome
              varies, and claiming "copied" after a refusal left users pasting
              whatever was there before. */}
          {copyFailed === "review"
            ? "Review link created — your browser blocked the clipboard, so copy it here: "
            : copied === "review"
              ? "✓ review link copied — "
              : "Review link created — "}
          <a href={reviewUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{reviewUrl}</a>{" "}
          (no login; the client picks one take)
          {copied !== "review" && copyFailed !== "review" && (
            <button onClick={() => void copy(reviewUrl, "review")} className="ml-2 underline underline-offset-2">copy</button>
          )}
        </p>
      )}
      {reviewErr && <ErrorBanner className="mb-3">{reviewErr}</ErrorBanner>}

      {/* The empty log TEACHES rather than states: a flat rail and the take
          that is not on it (signal.tsx::EmptyTakes). The sentence is
          unchanged — it is the drawing's caption now. */}
      {takes.length === 0 && !busy && (
        <div className="rounded-2xl border border-dashed border-white/10 text-white/60">
          <EmptyTakes still={still} />
        </div>
      )}

      <AnimatePresence initial={false}>
        {renderStatus}

        {takes.map((t, i) => (
          // The newest take, and only ever one of them: the arrival hairline
          // is a marker, not card chrome (signal.tsx::TakeArrival).
          <PlaygroundTakeCard key={t.id} take={t} newest={i === 0} {...card} />
        ))}
      </AnimatePresence>
    </div>
  );
}
