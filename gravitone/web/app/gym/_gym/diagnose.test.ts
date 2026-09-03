// The findings engine is now load-bearing: the internal lens accuses a
// Character of needing voice work, and an accusation derived from the wrong
// reading of `fallback` would send someone to re-record a slot that is fine.
// These pin the three internal rules against a fixture recording shaped like
// what service/recording.py writes, and pin the external rules that were here
// before so the new lens cannot quietly move them.

import { describe, expect, it } from "vitest";

import { diagnose } from "./diagnose";
import type { RecordedTurn, SpokeEntry } from "./types";

function spoke(over: Partial<SpokeEntry> = {}): SpokeEntry {
  return {
    voice_id: "v_ana_baseline",
    tts: "pocket-tts",
    emotion: null,
    used: null,
    fallback: false,
    ...over,
  };
}

function agent(at_s: number, over: Partial<RecordedTurn> = {}): RecordedTurn {
  return { role: "agent", text: "Right away.", at_s, answer_s: 0.4, ...over };
}

function caller(at_s: number, over: Partial<RecordedTurn> = {}): RecordedTurn {
  return { role: "candidate", text: "Hello.", at_s, audio_s: 1, transcribe_s: 0.3, ...over };
}

/** A call in which the brain asked for three emotions and got three different
 *  answers: a substitution, a request nothing could serve, and a derived slot. */
function fixture(): RecordedTurn[] {
  return [
    caller(0),
    agent(1, {
      spoke: [
        spoke({ emotion: "excited", used: "happy", fallback: true, voice_id: "v_ana_happy" }),
      ],
    }),
    caller(4),
    agent(5, {
      // Two parts of one reply on the same missing slot — one TURN, not two.
      spoke: [
        spoke({ emotion: "excited", used: "happy", fallback: true, voice_id: "v_ana_happy" }),
        spoke({ emotion: "excited", used: "happy", fallback: true, voice_id: "v_ana_happy" }),
      ],
    }),
    caller(8),
    agent(9, {
      spoke: [spoke({ emotion: "whisper", used: null, fallback: true, tts: "piper" })],
    }),
    caller(12),
    agent(13, {
      spoke: [
        // The slot EXISTS and spoke — resolve() still flags it, because it is
        // derived. Benign entries sit beside it and must produce nothing.
        spoke({ emotion: "sad", used: "sad", fallback: true }),
        spoke({ emotion: "happy", used: "happy", fallback: false }),
        spoke({ emotion: null, used: null, fallback: null }),
      ],
    }),
  ];
}

const internal = (turns: RecordedTurn[], name?: string | null) =>
  diagnose("conv_fixture", turns, { characterName: name }).filter((f) => f.lens === "internal");

describe("diagnose — the internal lens reads the mouth telemetry", () => {
  it("names the Character, the requested emotion, what spoke, and how many turns", () => {
    const found = internal(fixture(), "Ana");
    const unmet = found.find((f) => f.kind === "unmet-emotion");
    expect(unmet).toBeDefined();
    expect(unmet!.summary).toContain("Ana");
    expect(unmet!.summary).toContain("[excited]");
    expect(unmet!.summary).toContain("happy");
    // Two agent TURNS carried it, though one of them carried two parts.
    expect(unmet!.evidence).toContain("2 of 4 agent turns");
    expect(unmet!.turn).toBe(1);
    expect(unmet!.at_s).toBe(1);
  });

  it("does not accuse a derived slot of speaking the wrong emotion", () => {
    const found = internal(fixture(), "Ana");
    const derived = found.find((f) => f.kind === "derived-emotion");
    expect(derived).toBeDefined();
    // It spoke exactly what was asked for; the gap is a missing RECORDING.
    expect(derived!.summary).toContain("[sad]");
    expect(derived!.summary).toMatch(/derived slot/);
    expect(derived!.summary).not.toMatch(/instead/);
    // …and it is never a concern, however much of the call it touched.
    expect(derived!.severity).toBe("notice");
  });

  it("separates a request nothing could answer from a substitution", () => {
    const found = internal(fixture(), "Ana");
    const voiceless = found.find((f) => f.kind === "voiceless-emotion");
    expect(voiceless).toBeDefined();
    expect(voiceless!.summary).toContain("Piper");
    expect(voiceless!.summary).toContain("[whisper]");
    expect(voiceless!.severity).toBe("concern"); // 1 of 4 turns ≥ 25%
  });

  it("falls back to the voice_id when the roster could not name the Character", () => {
    const found = internal(fixture(), null);
    expect(found.find((f) => f.kind === "unmet-emotion")!.summary).toContain("v_ana_happy");
  });

  it("scales severity to the session, not to a magic count", () => {
    const turns: RecordedTurn[] = [];
    for (let i = 0; i < 12; i += 1) {
      turns.push(caller(i * 2));
      turns.push(
        agent(i * 2 + 1, {
          spoke:
            i === 0
              ? [spoke({ emotion: "excited", used: "happy", fallback: true })]
              : [spoke({ emotion: "happy", used: "happy", fallback: false })],
        }),
      );
    }
    const found = internal(turns, "Ana");
    expect(found).toHaveLength(1);
    // One line in twelve is a coverage gap worth naming, not a wrong-sounding call.
    expect(found[0].severity).toBe("notice");
    expect(found[0].evidence).toContain("1 of 12 agent turns");
  });

  it("gives every finding a distinct id, including two rules on one turn", () => {
    const found = diagnose("conv_fixture", fixture(), { characterName: "Ana" });
    expect(new Set(found.map((f) => f.id)).size).toBe(found.length);
  });

  it("derives nothing — never a clean bill — from a recording with no telemetry", () => {
    const turns = fixture().map(({ spoke: _drop, ...t }) => t);
    expect(internal(turns, "Ana")).toHaveLength(0);
  });
});

describe("diagnose — the external lens is unchanged by the new one", () => {
  const external = (turns: RecordedTurn[]) =>
    diagnose("conv_fixture", turns).filter((f) => f.lens === "external");

  it("finds nothing external in a healthy call that has mouth telemetry", () => {
    expect(external(fixture())).toHaveLength(0);
  });

  it("still flags a barge-in, leaked markup, a monologue and a slow answer", () => {
    const kinds = external([
      caller(0),
      agent(1, { interrupted: true }),
      agent(2, { text: "Sure. [emotion:happy] Here you go." }),
      agent(3, { text: "One. Two. Three. Four." }),
      agent(4, { answer_s: 9.2 }),
    ]).map((f) => f.kind);
    expect(kinds).toContain("barge-in");
    expect(kinds).toContain("leaked-markup");
    expect(kinds).toContain("monologue");
    expect(kinds).toContain("slow-answer");
  });

  it("still flags a call the caller was never heard in", () => {
    expect(external([agent(1)]).map((f) => f.kind)).toContain("one-sided");
  });
});
