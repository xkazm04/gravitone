"use client";

// The director's surface: the one control that acts on THE WHOLE TEXT, the
// answer it always gives, and the proposal it leaves behind for review.
//
// It proposes and never applies — every row here is a question, and the string
// only changes when the parent folds an accepted row through `applyEmotion`.
// Split out of ScoreEditor so the panel's other half (what acts on the
// SELECTION) is readable without scrolling past a review list.

import { emotionMeta } from "@/lib/emotions";
import { fallbackNote, REASONS, type Suggestion } from "./suggest";

export default function ScoreDirector({
  text,
  suggestions,
  directorNote,
  choices,
  available,
  disabled = false,
  onDirect,
  onAcceptAll,
  onDismissAll,
  onAccept,
  onReject,
  onRetag,
}: {
  /** PLAIN text — the same characters the suggestions' offsets are counted in. */
  text: string;
  /** The director's open proposal. Never part of the string. */
  suggestions: Suggestion[];
  /** The answer to the button. Absent → it has not been pressed yet. */
  directorNote: string | null;
  /** The emotions offered, for re-aiming a row. */
  choices: string[];
  /** Emotions this Character has actually recorded (for the fallback note). */
  available: string[];
  disabled?: boolean;
  onDirect: () => void;
  onAcceptAll: () => void;
  onDismissAll: () => void;
  onAccept: (index: number) => void;
  onReject: (index: number) => void;
  onRetag: (index: number, value: string) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-t border-white/8 pt-3">
        <button
          type="button"
          onClick={onDirect}
          disabled={disabled || text.trim().length === 0}
          className="font-jetbrains rounded-full border border-violet-400/30 bg-violet-400/5 px-3 py-1 text-[11px] text-violet-200 transition enabled:hover:bg-violet-400/10 disabled:opacity-40"
        >
          ✎ direct this text
        </button>
        {suggestions.length > 0 && (
          <>
            <button
              type="button"
              onClick={onAcceptAll}
              disabled={disabled}
              className="font-jetbrains rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/75 transition enabled:hover:border-emerald-400/40 enabled:hover:text-emerald-200 disabled:opacity-40"
            >
              accept all
            </button>
            <button
              type="button"
              onClick={onDismissAll}
              className="font-jetbrains rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/60 transition hover:border-white/30 hover:text-white/80"
            >
              dismiss all
            </button>
          </>
        )}
      </div>

      {/* The ANSWER to the button — its own block, at reading size.
          This was a 10px `text-white/50` span wedged into the button row, so
          the one outcome a first-time user always got (the shipped default text
          has exactly one cue, and it is already directed) looked identical to
          having pressed nothing. An action whose only response is invisible is
          an action that "does not do anything". */}
      {directorNote && (
        <p
          aria-live="polite"
          data-testid="director-note"
          className="font-hanken rounded-xl border border-violet-300/25 bg-violet-400/[0.06] px-3 py-2 text-[12px] leading-relaxed text-violet-100/90"
        >
          {directorNote}
        </p>
      )}

      {/* The review. Every row states the RULE that produced it, because the
          rule is the whole explanation — this pass reads punctuation, capitals
          and brackets, and a user who is shown that can forgive a weak call.
          A confident, unexplained guess is the thing to avoid: it would be
          claiming a comprehension nothing here has. */}
      {suggestions.length > 0 && (
        <ul className="space-y-1.5 rounded-xl border border-dashed border-violet-300/25 bg-violet-400/[0.03] px-3 py-2">
          {suggestions.map((s, i) => {
            const m = emotionMeta(s.value);
            const note = fallbackNote(s.value, available);
            return (
              <li key={`${s.start}-${s.reason}`} className="flex flex-wrap items-center gap-2">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed"
                  style={{ borderColor: `hsl(${m.hue} 88% 68%)`, background: `hsl(${m.hue} 82% 55% / 0.2)` }}
                />
                <span className="font-hanken min-w-0 flex-1 truncate text-[12px] text-white/80">
                  &ldquo;{text.slice(s.start, s.end)}&rdquo;
                </span>
                <select
                  value={s.value}
                  disabled={disabled}
                  onChange={(e) => onRetag(i, e.target.value)}
                  aria-label={`Emotion for the suggestion at characters ${s.start} to ${s.end}`}
                  className="font-jetbrains rounded-lg border border-white/15 bg-black/40 px-2 py-0.5 text-[11px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
                >
                  {[...new Set([s.value, ...choices])].map((id) => (
                    <option key={id} value={id} className="bg-slate-900 text-white">{emotionMeta(id).label}</option>
                  ))}
                </select>
                <span className="font-jetbrains text-[10px] text-white/45">{REASONS[s.reason]}</span>
                <button
                  type="button"
                  onClick={() => onAccept(i)}
                  disabled={disabled}
                  aria-label={`Accept ${m.label} for "${text.slice(s.start, s.end)}"`}
                  className="font-jetbrains rounded-full border border-white/15 px-2.5 py-0.5 text-[11px] text-white/75 transition enabled:hover:border-emerald-400/40 enabled:hover:text-emerald-200 disabled:opacity-40"
                >
                  accept
                </button>
                <button
                  type="button"
                  onClick={() => onReject(i)}
                  aria-label={`Reject ${m.label} for "${text.slice(s.start, s.end)}"`}
                  className="font-jetbrains rounded-full border border-white/15 px-2.5 py-0.5 text-[11px] text-white/55 transition hover:border-rose-400/40 hover:text-rose-200"
                >
                  reject
                </button>
                {note && <span className="font-jetbrains w-full text-[10px] text-amber-200/80">{note}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
