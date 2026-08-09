// The forensic room's findings engine: pure derivation from a recorded
// transcript, no fetch, no state. Every finding lands in one of two lenses:
//
//   internal — the Character's voice needs care (retraining, emotion work).
//     Derived from the recorder's per-turn mouth telemetry
//     (`RecordedTurn.spoke`, written by service/recording.py::Turn.spoke and
//     filled in service/convai.py::_synthesize): which voice spoke, which
//     emotion the brain ASKED for, which slot actually answered, and whether
//     that was a fallback. A turn whose request went unmet is exactly "this
//     Character's voice needs care" — the missing take is named, not guessed.
//     Recordings made before that telemetry landed carry no `spoke` at all;
//     they derive nothing here rather than a fabricated clean bill, and the
//     ear (the inspector's players) stays the instrument for them.
//
//   external — an indication for the developers of the brain/pipeline that
//     something is breaking technically or logically. Indications, not fixes:
//     their pipeline, their debugging.
//
// Rules are deliberately few and evidence-first: each finding carries the
// number or text that backs it, and a turn index + at_s so the inspector can
// seek straight to the moment.

import type { RecordedTurn, SpokeEntry } from "./types";

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

/** Share of the session's agent turns an unmet emotion request must touch
 *  before it stops being a notice and becomes a concern. Session-relative on
 *  purpose: one substituted line in a forty-turn call is a coverage gap worth
 *  knowing about; a quarter of the call speaking the wrong take is the
 *  Character sounding wrong to the caller. */
const UNMET_EMOTION_CONCERN_SHARE = 0.25;

/** The internal-lens rules, in the order the board reads them. Exported so the
 *  view groups by rule without inventing its own list. */
export const INTERNAL_KINDS = [
  "unmet-emotion",
  "voiceless-emotion",
  "derived-emotion",
] as const;
export type InternalKind = (typeof INTERNAL_KINDS)[number];

const sentenceCount = (text: string): number =>
  (text.match(/[.!?]+(?=\s|$)/g) ?? []).length || (text.trim() ? 1 : 0);

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** What the caller knows that the transcript alone does not: whose voice this
 *  session's agent spoke with. Used only to NAME the Character in an internal
 *  finding; absent, the finding names the raw voice_id it saw. */
export type DiagnoseContext = { characterName?: string | null };

/** Every finding the rules can see in one recorded conversation. */
export function diagnose(
  session: string,
  turns: RecordedTurn[],
  context: DiagnoseContext = {},
): Finding[] {
  const out: Finding[] = [];
  const push = (f: Omit<Finding, "id" | "session">, discriminator?: string) =>
    out.push({
      ...f,
      session,
      id: `${session}:${f.kind}:${f.turn ?? "s"}${discriminator ? `:${discriminator}` : ""}`,
    });

  const answers = turns
    .map((t) => t.answer_s)
    .filter((v): v is number => typeof v === "number");
  const answerMedian = median(answers);
  const agentTurns = turns.filter((t) => t.role === "agent").length;
  const mouths = new Map<string, MouthGroup>();

  turns.forEach((t, i) => {
    if (t.role === "agent") {
      for (const entry of t.spoke ?? []) collectMouth(mouths, entry, i, t.at_s);
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

  for (const group of [...mouths.values()].sort(
    (a, b) => a.turns[0] - b.turns[0] || a.kind.localeCompare(b.kind),
  )) {
    const who = context.characterName ?? group.voiceId;
    const n = group.turns.length;
    const share = agentTurns ? n / agentTurns : 0;
    const scope = `${n} of ${agentTurns} agent turn${agentTurns === 1 ? "" : "s"}`;
    push(
      {
        lens: "internal",
        kind: group.kind,
        // A derived slot DID speak the emotion asked for — it is a missing
        // recording, never a wrong-sounding line. Only a substitution or a
        // request nothing could answer scales to a concern.
        severity:
          group.kind !== "derived-emotion" && share >= UNMET_EMOTION_CONCERN_SHARE
            ? "concern"
            : "notice",
        turn: group.turns[0],
        at_s: group.firstAt,
        summary: mouthSummary(group, who),
        evidence:
          group.kind === "unmet-emotion"
            ? `${scope} · asked [${group.emotion}], ${group.used} spoke · voice ${group.voiceId}`
            : `${scope} · asked [${group.emotion}] · ${group.tts} voice ${group.voiceId}`,
      },
      `${group.emotion}:${group.used ?? "none"}`,
    );
  }

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

// ---------------------------------------------------------------------------
// The internal lens: what the mouth telemetry says about a Character's slots.
// ---------------------------------------------------------------------------

type MouthGroup = {
  kind: InternalKind;
  /** What the brain asked for. */
  emotion: string;
  /** The slot that actually spoke, when one resolved. */
  used: string | null;
  tts: string;
  voiceId: string;
  /** Every agent turn this group touched, in order. */
  turns: number[];
  firstAt?: number;
};

/** Which rule (if any) one `spoke` entry trips.
 *
 *  `fallback` is NOT simply "the request went unmet" — emotions.resolve sets it
 *  true ALSO when the requested slot exists but is DERIVED (a computed stand-in
 *  for a take nobody recorded), and that case has `used === emotion`. The three
 *  kinds keep those apart, because accusing a Character of speaking the wrong
 *  emotion when it spoke the right one would be a false finding:
 *
 *    unmet-emotion    — asked for X, slot Y spoke instead.
 *    voiceless-emotion— asked for X and nothing resolved at all (no Character
 *                       owns the voice, or the mouth has no emotion slots).
 *    derived-emotion  — X was spoken, from a computed slot, not a recording.
 */
function mouthKind(entry: SpokeEntry): InternalKind | null {
  if (!entry.fallback || !entry.emotion) return null;
  if (entry.used === null) return "voiceless-emotion";
  if (entry.used === entry.emotion) return "derived-emotion";
  return "unmet-emotion";
}

function collectMouth(
  groups: Map<string, MouthGroup>,
  entry: SpokeEntry,
  turn: number,
  atS: number,
): void {
  const kind = mouthKind(entry);
  if (!kind || !entry.emotion) return;
  const key = `${kind}|${entry.voice_id}|${entry.emotion}|${entry.used ?? ""}`;
  const group = groups.get(key);
  if (!group) {
    groups.set(key, {
      kind,
      emotion: entry.emotion,
      used: entry.used,
      tts: entry.tts,
      voiceId: entry.voice_id,
      turns: [turn],
      firstAt: atS,
    });
    return;
  }
  // One turn can hold several parts on the same slot — count the TURN once.
  if (group.turns[group.turns.length - 1] !== turn) group.turns.push(turn);
}

function mouthSummary(group: MouthGroup, who: string): string {
  switch (group.kind) {
    case "unmet-emotion":
      return `The brain asked ${who} for [${group.emotion}] and the ${group.used} take spoke instead — ${who} has no ${group.emotion} recorded.`;
    case "voiceless-emotion":
      return `The brain asked ${who} for [${group.emotion}] and nothing could answer it — ${
        group.tts === "piper"
          ? "this is a Piper mouth, which has no emotion slots"
          : "no Character owns this voice"
      }, so the configured voice spoke it unchanged.`;
    case "derived-emotion":
      return `${who} spoke [${group.emotion}] from a derived slot — a computed stand-in, not a recorded take. Recording the real one is the upgrade.`;
  }
}

/** What the internal lens can honestly say about a session whose recording
 *  predates mouth telemetry: nothing, and it says so rather than reading as a
 *  clean bill of health. */
export const INTERNAL_LENS_LIMIT =
  "These sessions were recorded before per-turn mouth telemetry landed, so the rules can see no emotion requests in them — that is a blind spot, not a clean result. Your ear is the instrument here: open a session and listen.";
