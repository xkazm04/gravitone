"use client";

// The director's state — a proposal that is NOT the string.
//
// Everything else in the score edits `value`; this holds the one thing that
// deliberately does not reach it until the user says so. Keeping it in its own
// hook is what makes that separation legible: the composer can render a
// proposal, and there is no path from here to the engine that does not go
// through the composer's own `applyEmotion`.
//
// The two mutations that belong to a MOMENT rather than to the director — a
// proposal dropped because the words changed, a proposal withdrawn because the
// user directed those words themselves — stay at their call sites in the
// composer, which is where their reasons are written down. `setSuggestions` is
// exposed for them.

import { useState } from "react";
import { accept, proposalSummary, reviewText, type Suggestion } from "./suggest";
import type { ScoreRegion } from "./shared";

export function useScoreDirector({
  value,
  text,
  regions,
  choices,
  onChange,
  onNotice,
  onApplied,
}: {
  /** The composer's raw text — metatags included. This is the contract. */
  value: string;
  /** …and the same characters without them, which offsets are counted in. */
  text: string;
  regions: ScoreRegion[];
  /** The emotions this Character can actually be directed with. */
  choices: string[];
  onChange: (next: string) => void;
  /** The composer's amber live region, for a refusal. */
  onNotice: (message: string | null) => void;
  /** …and its quiet one, for the case that works. */
  onApplied: (message: string | null) => void;
}) {
  // The director's open proposal. Never part of `value` — a suggestion the user
  // has not accepted must not reach the engine, and this state is the whole
  // reason it cannot.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [directorNote, setDirectorNote] = useState<string | null>(null);

  // ── the director ───────────────────────────────────────────────────────────
  /** Propose spans over the current text. Synchronous and local — there is no
   *  request to gate, cancel or fail, because there is no model: see suggest.ts
   *  for why this is rules rather than the narrate endpoint the idea assumed. */
  function direct() {
    // `reviewText`, not `propose`: a list has one empty value and this pass has
    // THREE empty outcomes, which used to be reported with the one sentence
    // that happened to be wrong for the default text. The note below always
    // changes, so the click always has a visible answer.
    const outcome = reviewText(text, choices, regions);
    setSuggestions(outcome.suggestions);
    setDirectorNote(proposalSummary(outcome));
    onNotice(null);
  }

  /** Accept some of the proposal. One fold through `applyEmotion`, so an
   *  accepted suggestion is exactly a hand-placed region — and a refusal is
   *  reported in the composer's own words rather than counted as a success. */
  function take(indexes: number[]) {
    const result = accept(value, suggestions, indexes);
    const survivors = suggestions.filter(
      (s, i) => !indexes.includes(i) || result.refused.some((r) => r.suggestion === s),
    );
    setSuggestions(survivors);
    if (result.applied > 0) {
      onChange(result.next);
      onApplied(`Accepted ${result.applied} suggestion${result.applied === 1 ? "" : "s"}.`);
    }
    onNotice(result.refused[0]?.why ?? null);
    setDirectorNote(
      survivors.length > 0
        ? `${survivors.length} suggestion${survivors.length === 1 ? "" : "s"} left to review.`
        : null,
    );
  }

  function dismissAll() {
    setSuggestions([]);
    setDirectorNote("Suggestions dismissed — nothing was changed.");
  }

  return { suggestions, setSuggestions, directorNote, setDirectorNote, direct, take, dismissAll };
}
