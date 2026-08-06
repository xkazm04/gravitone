// The director — a FIRST PASS over the composer's text, not a reading of it.
//
// The brief that produced this file assumed the service could already annotate
// arbitrary text with emotions, because `narrate.py` emits
// `[emotion]…[/emotion]` blocks. It cannot. Narrate's emotion comes from a
// five-entry map keyed on DOCUMENT STRUCTURE (`narrate.py::_ROLE`:
// lead→excited, heading→calm, body/list→baseline, quote→calm), so POSTing one
// user paragraph as `markdown` returns exactly ONE block tagged `[excited]`
// around the whole thing — a constant, not a suggestion. A sweep of the rest of
// the service found no text→emotion inference anywhere: `direction.py` counts
// human swaps after the fact, `prosody.py` and `ingest.py` listen to AUDIO
// (ingest's own prompt says "vocal tone/prosody, not the words"), and
// `emotion_basis.py` is embedding arithmetic.
//
// So this is rules, and it says so out loud. Everything here reads punctuation,
// casing and bracketing — the SHAPE of the writing. It does not know what the
// words mean and the UI must never imply that it does, which is why every
// suggestion carries the `reason` that produced it: a user who can see "ends in
// an exclamation" can forgive a weak call, and a user shown a confident
// unexplained guess cannot.
//
// Tuned for PRECISION over recall on purpose. Three suggestions that are all
// sensible are worth more than twelve where half are noise — a noisy first pass
// costs more attention to audit than it saves, and it teaches the user to press
// "dismiss all" forever.

import { emotionMeta } from "@/lib/emotions";
import { applyEmotion, scoreRegion, type ScoreRegion } from "./shared";

/** Why a span was proposed. Shown to the user verbatim (via `REASONS`) — the
 *  rule IS the explanation, because there is no deeper one. */
export type SuggestReason = "parenthetical" | "shout" | "exclamation" | "question" | "ellipsis";

/** One proposed span. Same shape as a `ScoreRegion` plus the rule that made it,
 *  so accepting one is literally placing the region it already describes. */
export type Suggestion = { start: number; end: number; value: string; reason: SuggestReason };

/**
 * The seam.
 *
 * One signature — plain text plus the emotion vocabulary that is allowed —
 * returning spans with a stated reason each. `heuristicDirector` is the only
 * shipped implementation and the only one this build needs.
 *
 * The future candidate, if a model-backed pass is ever wanted, is already in
 * this repo: `service/dialog.py`'s `ClaudeCliBackend` (spawns headless
 * `claude -p` against the machine's own subscription — no API key) plus
 * `_SentenceBuffer`'s `[emotion:x]` bracket grammar, which is a tested parser
 * for exactly this output. It would need a new route, a new prompt and an
 * honest "unavailable" state (the default brain is `scripted`), which is why it
 * is a seam and not an implementation.
 */
export type Director = (plain: string, vocabulary: string[]) => Suggestion[];

/** What each rule is called where the user can read it. Deliberately describes
 *  the TEXT, never the sentiment: "ends in an exclamation" is a fact, "sounds
 *  excited" is a claim this file cannot support. */
export const REASONS: Record<SuggestReason, string> = {
  parenthetical: "a bracketed aside",
  shout: "written in capitals",
  exclamation: "ends in an exclamation",
  question: "a question",
  ellipsis: "trails off",
};

/**
 * Which emotion each rule proposes, and which rule wins a collision.
 *
 * Rank is precision order, not importance: a bracketed aside is a narrow,
 * reliable signal and beats the sentence-level rules it sits inside; a shout is
 * more specific than the exclamation mark that usually ends it.
 */
const RULES: Record<SuggestReason, { emotion: string; rank: number }> = {
  parenthetical: { emotion: "whisper", rank: 0 },
  shout: { emotion: "angry", rank: 1 },
  exclamation: { emotion: "excited", rank: 2 },
  question: { emotion: "confused", rank: 3 },
  ellipsis: { emotion: "sad", rank: 4 },
};

/**
 * A span too short to be worth directing.
 *
 * "Hi!" is a real exclamation and a pointless region: three characters of
 * tagged audio is a Voice switch nobody can hear and a row everybody has to
 * dismiss. Precision means declining the ones that are technically right and
 * practically worthless.
 */
const MIN_SPAN = 8;

/** Sentence ends, and the newlines that end one just as firmly. */
const TERMINATOR = /[.!?…]+["')\]]*|\n+/g;
/** A bracketed aside with something actually in it. Nested brackets are
 *  excluded rather than guessed at. */
const PARENTHETICAL = /\([^()\n]{2,}\)/g;

/** Trim a span to the characters that are not whitespace, in offsets. Returns
 *  null when nothing is left — the honest answer for a run of blank lines.
 *  Length is NOT judged here: a four-word sentence is still a sentence, it is
 *  just not worth a region (`MIN_SPAN`, enforced where suggestions are made). */
function tighten(text: string, start: number, end: number): { start: number; end: number } | null {
  let a = start;
  let b = end;
  while (a < b && /\s/.test(text[a])) a += 1;
  while (b > a && /\s/.test(text[b - 1])) b -= 1;
  return b > a ? { start: a, end: b } : null;
}

/** The text cut into sentences, in offsets over the ORIGINAL string — the same
 *  coordinate space regions live in, so nothing has to be mapped back. */
export function sentences(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let at = 0;
  const take = (a: number, b: number) => {
    const span = tighten(text, a, b);
    if (span) out.push(span);
  };
  for (const m of text.matchAll(TERMINATOR)) {
    const end = m.index + m[0].length;
    if (!endsHere(text, end)) continue;
    take(at, end);
    at = end;
  }
  take(at, text.length); // a final sentence with no terminator is still a sentence
  return out;
}

/**
 * Is the terminator at `end` really the end of a sentence?
 *
 * Only if nothing follows it, or what follows starts a new one. A lowercase
 * continuation — "He said stop! and then walked away.", "It was over (!!!) and
 * that was that." — means the mark was emphasis or an aside INSIDE a clause,
 * and cutting there would hand back a fragment tagged as though the writer had
 * finished a thought. This pass is not confident enough to cut clauses, so it
 * declines to; the cost is that a genuinely new sentence beginning with a
 * lowercase word is missed, which is the direction to err in.
 */
function endsHere(text: string, end: number): boolean {
  const rest = text.slice(end);
  if (rest.trim() === "") return true;
  if (/^\n/.test(rest)) return true; // a line break ends a line, whatever follows
  return !/^\s*\p{Ll}/u.test(rest);
}

/** Is this span shouted? Enough letters to be sure, nearly all of them capital,
 *  and more than one word — a single capitalised word is an acronym far more
 *  often than it is a raised voice. */
function isShout(slice: string): boolean {
  const letters = slice.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return false;
  if (slice.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length < 2) return false;
  const caps = letters.replace(/[^A-Z]/g, "").length;
  return caps / letters.length >= 0.8;
}

/** The rules, in the order they are looked for. Pure and separately testable so
 *  a rule can be judged without rendering anything. */
function candidates(text: string): Suggestion[] {
  const found: Suggestion[] = [];
  const add = (start: number, end: number, reason: SuggestReason) => {
    const span = tighten(text, start, end);
    if (!span || span.end - span.start < MIN_SPAN) return;
    if (!/[A-Za-z0-9]/.test(text.slice(span.start, span.end))) return; // "(!!!)" is not an aside
    found.push({ ...span, value: RULES[reason].emotion, reason });
  };

  for (const m of text.matchAll(PARENTHETICAL)) add(m.index, m.index + m[0].length, "parenthetical");

  for (const { start, end } of sentences(text)) {
    const slice = text.slice(start, end);
    if (isShout(slice)) { add(start, end, "shout"); continue; }
    // Read the terminator, not the whole slice — and read it past any closing
    // quote or bracket, so `He shouted "stop!"` is still an exclamation.
    const tail = slice.replace(/["')\]]+$/, "");
    if (tail.endsWith("!")) add(start, end, "exclamation");
    else if (tail.endsWith("?")) add(start, end, "question");
    else if (tail.endsWith("…") || tail.endsWith("...")) add(start, end, "ellipsis");
  }
  return found;
}

/**
 * The shipped director.
 *
 * `vocabulary` is the active Character's SCALE — an emotion that is not on it
 * cannot be addressed by an inline tag on this Character at all, so a rule
 * whose emotion is missing produces nothing rather than a suggestion the
 * composer would have to refuse. (An emotion that is on the scale but not
 * RECORDED is a different thing entirely and IS suggested: it renders through
 * the fallback chain, and the UI marks that consequence in `composerWarnings`'
 * own words.)
 *
 * Collisions are resolved by rank, first-wins, so the output is always disjoint
 * — which is what `toTags` requires anyway, the grammar having no nesting.
 */
export const heuristicDirector: Director = (plain, vocabulary) => {
  const allowed = new Set(vocabulary.map((v) => v.toLowerCase()));
  const ranked = candidates(plain)
    .filter((s) => allowed.has(s.value))
    .sort((a, b) => RULES[a.reason].rank - RULES[b.reason].rank || a.start - b.start);

  const kept: Suggestion[] = [];
  for (const s of ranked) {
    if (kept.some((k) => k.start < s.end && s.start < k.end)) continue;
    kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
};

/**
 * Open a review session over `plain`.
 *
 * Spans the user has ALREADY directed are dropped rather than proposed over: a
 * machine second-guessing a decision the human just made is the fastest way to
 * make the feature feel adversarial, and the region would be refused by
 * `regionProblem` anyway (the grammar cannot nest).
 */
export function propose(
  plain: string,
  vocabulary: string[],
  existing: ScoreRegion[],
  director: Director = heuristicDirector,
): Suggestion[] {
  return director(plain, vocabulary)
    .filter((s) => !existing.some((r) => r.start < s.end && s.start < r.end));
}

/** Drop one suggestion. */
export function reject(list: Suggestion[], index: number): Suggestion[] {
  return list.filter((_, i) => i !== index);
}

/** Re-aim one suggestion at a different emotion, keeping its span and the
 *  reason that found it — the rule still explains WHY these words were picked
 *  out, even once the user has overruled WHAT they should sound like. */
export function retag(list: Suggestion[], index: number, value: string): Suggestion[] {
  return list.map((s, i) => (i === index ? { ...s, value } : s));
}

/** The outcome of accepting suggestions: the new tagged string, how many landed,
 *  and any that were REFUSED with the composer's own sentence — never a silent
 *  drop, and never a count that overstates what happened. */
export type AcceptResult = { next: string; applied: number; refused: Array<{ suggestion: Suggestion; why: string }> };

/**
 * Accept some suggestions into `tagged`.
 *
 * Folded through `shared.applyEmotion` one at a time rather than assembled
 * directly, so an accepted suggestion is EXACTLY a hand-placed region — same
 * validation, same refusals, same words. A region edit never changes the plain
 * text, so the remaining offsets stay valid across the fold.
 */
export function accept(tagged: string, list: Suggestion[], indexes: number[]): AcceptResult {
  const wanted = new Set(indexes);
  let next = tagged;
  let applied = 0;
  const refused: AcceptResult["refused"] = [];
  list.forEach((s, i) => {
    if (!wanted.has(i)) return;
    const edit = applyEmotion(next, s.start, s.end, s.value);
    if (edit.next === null) {
      refused.push({ suggestion: s, why: edit.message ?? "That region could not be placed." });
      return;
    }
    next = edit.next;
    applied += 1;
  });
  return { next, applied, refused };
}

/** A suggestion as the region it would become — for the ghost drawn under the
 *  words, which must be the same span the accept button places. */
export function asRegion(s: Suggestion): ScoreRegion {
  return scoreRegion(s.start, s.end, s.value);
}

/** The one-line summary of a proposal run. States the METHOD, because a user
 *  who thinks this understood their writing will trust it more than it has
 *  earned. */
export function proposalSummary(count: number): string {
  if (count === 0) {
    return "No suggestions — this pass only reads punctuation, capitals and brackets, and found none of them here.";
  }
  return `${count} suggestion${count === 1 ? "" : "s"} from punctuation and phrasing — a first pass, not a reading. Review each.`;
}

/** The fallback consequence for a suggestion the Character has not recorded —
 *  `composerWarnings`' sentence, so the studio says this one thing one way. */
export function fallbackNote(value: string, available: string[]): string | null {
  if (available.length === 0 || available.includes(value)) return null;
  return `${emotionMeta(value).label} is not recorded for this Character — the nearest recorded emotion is used, then baseline.`;
}
