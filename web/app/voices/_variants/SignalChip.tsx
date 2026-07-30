"use client";

// SIGNAL CHIP — the one visual the Fidelity Ledger adds, and the only one.
//
// A small glass chip stating a NAMED, MEASURED fact about a recording:
// "clipped", "1.4s speech", "identity 0.91". It appears exactly where the studio
// measured something and renders NOTHING where it didn't — no placeholder, no
// "not measured", no zero. That is what makes the chip trustworthy: seeing one
// means something was heard.
//
// Two states, one accent each, both already in the design system:
//   * a measured fact with nothing wrong → the measurement accent (cyan), the
//     same accent every other "the service told us this" chip on these pages uses;
//   * a flag → amber, which on this surface already means "advisory, act on this"
//     (the "falls back to baseline" and "shadowed" hints).
// Never rose: a flagged take is not an error, and nothing here blocks anything.
//
// It lives beside CharacterTable rather than inside the rack because BOTH
// surfaces state the same facts and must state them identically; if the Signal
// Layer later ships a generic chip primitive, this is the single file to fold in.

import type { Signal } from "../_data/characters";

/**
 * @param signal   the fact to state (`signalOf(voice.fidelity)`), or null → nothing
 * @param note     extra context appended to the hover title (e.g. which slot)
 * @param as       "span" (default) — pass "div" only where a span is invalid
 */
export default function SignalChip({
  signal, note, className = "",
}: {
  signal: Signal | null;
  note?: string;
  className?: string;
}) {
  if (!signal) return null; // absent = invisible. The whole contract, one line.
  const flagged = signal.flag !== null;
  const title = note ? `${note} — ${signal.title}` : signal.title;
  return (
    <span
      title={title}
      aria-label={`${signal.label}. ${title}`}
      className={`font-jetbrains inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
        flagged
          ? "border-amber-400/25 bg-amber-400/10 text-amber-300"
          : "border-cyan-400/20 bg-cyan-400/10 text-cyan-300"
      } ${className}`}
    >
      {flagged && <span aria-hidden="true">⚠</span>}
      {signal.label}
    </span>
  );
}
