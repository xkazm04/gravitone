// The forensic room's findings engine: pure derivation from a recorded
// transcript, no fetch, no state. Every finding lands in one of two lenses:
//
//   internal — the Character's voice needs care (retraining, emotion work).
//     Round 1 derives almost nothing here by design: per-turn emotion
//     telemetry is not recorded yet, and inventing internal findings from
//     numbers that cannot show them would be the fabricated-zero bug in a new
//     costume. The internal lens is honest about that limit; the ear (the
//     inspector's players) is the round-1 instrument.
//
//   external — an indication for the developers of the brain/pipeline that
//     something is breaking technically or logically. Indications, not fixes:
//     their pipeline, their debugging.
//
// Rules are deliberately few and evidence-first: each finding carries the
// number or text that backs it, and a turn index + at_s so the inspector can
// seek straight to the moment.

import type { RecordedTurn } from "./types";

export type Lens = "internal" | "external";

export type Finding = {
  /** Stable within a session: `${session}:${kind}:${turn}` */
  id: string;
  lens: Lens;
  /** kebab-case rule name, doubles as the chip label */
  kind: string;
  /** notice = worth a look · concern = worth a fix */
  severity: "notice" | "concern";
  session: string;
  /** Index into the transcript's turns, when the finding is about one turn. */
  turn?: number;
  /** Seek target for the aligned tracks. */
  at_s?: number;
  summary: string;
  evidence: string;
};

/** Stage directions that must never be SPOKEN. Their appearance in an agent
 *  turn's text means the brain leaked markup past the dialog layer. */
const LEAKED_TAGS = ["[lang:", "[emotion", "[end_call]"];

/** An agent reply longer than this many sentences breaks the "short enough to
 *  listen to" brief (the suite expectations use the same idea). */
const MAX_AGENT_SENTENCES = 3;

/** answer_s above this is a concern regardless of the session's median. */
const SLOW_ANSWER_ABS_S = 8;

const sentenceCount = (text: string): number =>
  (text.match(/[.!?]+(?=\s|$)/g) ?? []).length || (text.trim() ? 1 : 0);

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Every finding the rules can see in one recorded conversation. */
export function diagnose(session: string, turns: RecordedTurn[]): Finding[] {
  const out: Finding[] = [];
  const push = (f: Omit<Finding, "id" | "session">) =>
    out.push({ ...f, session, id: `${session}:${f.kind}:${f.turn ?? "s"}` });

  const answers = turns
    .map((t) => t.answer_s)
    .filter((v): v is number => typeof v === "number");
  const answerMedian = median(answers);

  turns.forEach((t, i) => {
    if (t.role === "agent") {
      if (t.interrupted) {
        push({
          lens: "external",
          kind: "barge-in",
          severity: "concern",
          turn: i,
          at_s: t.at_s,
          summary: "The caller talked over this reply — it was cut off mid-speech.",
          evidence: `turn ${i} interrupted`,
        });
      }
      for (const tag of LEAKED_TAGS) {
        if (t.text.toLowerCase().includes(tag)) {
          push({
            lens: "external",
            kind: "leaked-markup",
            severity: "concern",
            turn: i,
            at_s: t.at_s,
            summary:
              "A stage direction leaked into spoken text — the brain emitted markup the dialog layer should have consumed.",
            evidence: `"…${excerptAround(t.text, tag)}…"`,
          });
          break;
        }
      }
      const sentences = sentenceCount(t.text);
      if (sentences > MAX_AGENT_SENTENCES) {
        push({
          lens: "external",
          kind: "monologue",
          severity: "notice",
          turn: i,
          at_s: t.at_s,
          summary: `This reply runs ${sentences} sentences — long enough that callers start talking over it.`,
          evidence: `${sentences} sentences (brief: ≤ ${MAX_AGENT_SENTENCES})`,
        });
      }
      if (typeof t.answer_s === "number") {
        const slowVsSession =
          answerMedian !== null && answers.length >= 2 && t.answer_s > 2 * answerMedian;
        if (t.answer_s > SLOW_ANSWER_ABS_S || slowVsSession) {
          push({
            lens: "external",
            kind: "slow-answer",
            severity: t.answer_s > SLOW_ANSWER_ABS_S ? "concern" : "notice",
            turn: i,
            at_s: t.at_s,
            summary: `The caller waited ${t.answer_s.toFixed(1)}s for this reply.`,
            evidence:
              answerMedian !== null
                ? `${t.answer_s.toFixed(2)}s vs session median ${answerMedian.toFixed(2)}s`
                : `${t.answer_s.toFixed(2)}s`,
          });
        }
      }
    }
    if (t.role === "candidate" && typeof t.transcribe_s === "number" && typeof t.audio_s === "number") {
      if (t.transcribe_s > t.audio_s) {
        push({
          lens: "external",
          kind: "slow-ear",
          severity: "notice",
          turn: i,
          at_s: t.at_s,
          summary:
            "Transcribing this utterance took longer than the utterance itself — the ear is the latency floor here.",
          evidence: `${t.transcribe_s.toFixed(2)}s to hear ${t.audio_s.toFixed(2)}s of speech`,
        });
      }
    }
  });

  if (!turns.some((t) => t.role === "candidate")) {
    push({
      lens: "external",
      kind: "one-sided",
      severity: "concern",
      summary:
        "The caller was never heard — every utterance either had no words in it or never reached the ear.",
      evidence: `${turns.length} turn(s), 0 from the caller`,
    });
  }

  return out;
}

function excerptAround(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return needle;
  return text.slice(Math.max(0, at - 12), at + needle.length + 12);
}

/** What the internal lens can honestly say per session in round 1. */
export const INTERNAL_LENS_LIMIT =
  "Per-turn emotion telemetry is not recorded yet — the internal lens is your ear: open a session, listen, and judge the Character. Slot-level findings arrive with recorder enrichment.";
