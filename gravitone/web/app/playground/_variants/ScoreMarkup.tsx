"use client";

// What the engine receives, shown verbatim.
//
// The escape hatch behind the score's `markup` toggle: the `[tags]` string is
// the contract, so an author who thinks in it can read it and copy it. Read
// only, always — the caret must never sit inside markup again.

import { useCopyFeedback } from "@/lib/useCopyFeedback";

export default function ScoreMarkup({ value, show }: {
  /** The composer's raw text — metatags included. This is the contract. */
  value: string;
  /** Whether the toggle in the score's header is on. The block owns its own
   *  visibility rather than being wrapped in the caller's `&&`, so hiding it
   *  does not unmount the copy feedback and re-label a button that was, one
   *  second ago, still saying "✓ copied". */
  show: boolean;
}) {
  const { copied, failed, copy } = useCopyFeedback();

  if (!show) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="font-jetbrains text-[10px] uppercase tracking-widest text-white/45">
          what the engine receives
        </span>
        <button
          type="button"
          onClick={() => void copy(value)}
          className="font-jetbrains rounded-full border border-white/15 px-2.5 py-0.5 text-[10px] text-white/60 transition hover:border-cyan-400/40 hover:text-cyan-200"
        >
          {failed ? "copy blocked" : copied ? "✓ copied" : "copy"}
        </button>
      </div>
      <pre className="font-jetbrains overflow-x-auto rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-cyan-100/80">
        {value || "(empty)"}
      </pre>
    </div>
  );
}
