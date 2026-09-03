// The Casting Board's rules. Every refusal here is one the SERVICE also
// enforces (service/ingest_api.py::cast) — said early, in the user's own terms.

import { describe, expect, it } from "vitest";
import {
  MAX_CAST_MEMBERS, castMembers, castOutcome, castProgress, castRefusal,
  memberStatusLabel,
} from "./cast";
import type { CastMember, Speaker } from "./machine";

const SPEAKERS: Speaker[] = [
  { id: "speaker_0", utterances: 8, seconds: 30, sample_text: "hello" },
  { id: "speaker_1", utterances: 6, seconds: 22, sample_text: "hi" },
  { id: "speaker_2", utterances: 3, seconds: 9, sample_text: "hey" },
];

const member = (over: Partial<CastMember>): CastMember => ({
  speaker_id: "speaker_0", character: "Ada", status: "pending", ...over,
});

describe("castMembers", () => {
  it("sends only the ticked speakers, in the order they are shown", () => {
    expect(castMembers({ speaker_2: "Cy", speaker_0: "Ada" }, SPEAKERS)).toEqual([
      { speaker_id: "speaker_0", character: "Ada" },
      { speaker_id: "speaker_2", character: "Cy" },
    ]);
  });

  it("trims the typed name — a trailing space is not a different character", () => {
    expect(castMembers({ speaker_0: "  Ada  " }, SPEAKERS)[0].character).toBe("Ada");
  });

  it("keeps a ticked-but-unnamed speaker, so the refusal can name it", () => {
    expect(castMembers({ speaker_1: "" }, SPEAKERS)).toEqual([
      { speaker_id: "speaker_1", character: "" },
    ]);
  });
});

describe("castRefusal", () => {
  it("passes a named selection", () => {
    expect(castRefusal([
      { speaker_id: "speaker_0", character: "Ada" },
      { speaker_id: "speaker_1", character: "Bo" },
    ])).toBeNull();
  });

  it("asks for a selection at all", () => {
    expect(castRefusal([])).toMatch(/tick the speakers/i);
  });

  it("names the unnamed speaker", () => {
    expect(castRefusal([{ speaker_id: "speaker_1", character: "" }]))
      .toMatch(/speaker_1/);
  });

  it("counts several unnamed speakers rather than naming one at random", () => {
    expect(castRefusal([
      { speaker_id: "speaker_0", character: "" },
      { speaker_id: "speaker_1", character: "" },
    ])).toMatch(/2 still have no Character name/);
  });

  it("refuses two names that would become the SAME character", () => {
    // The trap the service can only answer with a slug: both would race for the
    // same (character, emotion) slots and the second speaker's voices would be
    // skipped as "already held".
    const why = castRefusal([
      { speaker_id: "speaker_0", character: "Ada Lovelace" },
      { speaker_id: "speaker_1", character: "ada  lovelace" },
    ]);
    expect(why).toMatch(/same Character/);
    expect(why).toMatch(/Ada Lovelace/);
  });

  it("refuses two names with nothing sluggable in them — they collide", () => {
    // lib/slugs falls back to the literal "character" for a name with no
    // usable characters, so two of them ARE the same character id.
    expect(castRefusal([
      { speaker_id: "speaker_0", character: "!!!" },
      { speaker_id: "speaker_1", character: "???" },
    ])).toMatch(/same Character \(character\)/);
  });

  it("mirrors the service's cap", () => {
    const many = Array.from({ length: MAX_CAST_MEMBERS + 1 }, (_, i) => ({
      speaker_id: `speaker_${i}`, character: `N${i}`,
    }));
    expect(castRefusal(many)).toMatch(new RegExp(`${MAX_CAST_MEMBERS} Characters`));
  });
});

describe("castProgress", () => {
  it("counts settled members and points at the one in flight", () => {
    const p = castProgress({ members: [
      member({ speaker_id: "speaker_0", status: "done" }),
      member({ speaker_id: "speaker_1", character: "Bo", status: "cloning" }),
      member({ speaker_id: "speaker_2", character: "Cy", status: "pending" }),
    ] });
    expect(p).toMatchObject({ total: 3, settled: 1 });
    expect(p.current?.character).toBe("Bo");
  });

  it("counts a FAILED member as settled — the cast has moved past it", () => {
    expect(castProgress({ members: [member({ status: "error" })] }).settled).toBe(1);
  });

  it("is empty, not broken, before the first poll", () => {
    expect(castProgress(null)).toEqual({ total: 0, settled: 0, current: null });
  });
});

describe("memberStatusLabel", () => {
  it("states the clone's own numbers when the service has them", () => {
    expect(memberStatusLabel(member({ status: "cloning", emotions_done: 2, emotions_total: 5 })))
      .toBe("cloning voices · 2/5");
  });

  it("does not invent a total it has not been given", () => {
    expect(memberStatusLabel(member({ status: "cloning" }))).toBe("cloning voices");
  });

  it("counts what a finished member actually made", () => {
    expect(memberStatusLabel(member({
      status: "done", voices: [{ voice_id: "v1", emotion: "baseline" }],
    }))).toBe("1 voice(s) cloned");
  });
});

describe("castOutcome", () => {
  const made = (id: string, n: number): CastMember => member({
    speaker_id: id, character: id.toUpperCase(), status: "done",
    voices: Array.from({ length: n }, (_, i) => ({ voice_id: `${id}-${i}`, emotion: "baseline" })),
  });

  it("says how many characters and voices a clean cast made", () => {
    const out = castOutcome({ members: [made("a", 2), made("b", 3)] })!;
    expect(out.headline).toBe("2 Characters cast · 5 voices.");
    expect(out.failed).toHaveLength(0);
  });

  it("states a PARTIAL cast as partial — never '2 characters ready'", () => {
    const out = castOutcome({ members: [
      made("a", 2), member({ speaker_id: "b", status: "error", error: "too short" }),
    ] })!;
    expect(out.headline).toBe("1 of 2 Characters cast · 2 voices.");
    expect(out.failed.map((m) => m.error)).toEqual(["too short"]);
  });

  it("counts members that were never reached against the total too", () => {
    const out = castOutcome({ members: [made("a", 1), member({ speaker_id: "b", status: "pending" })] })!;
    expect(out.headline).toBe("1 of 2 Characters cast · 1 voice.");
  });

  it("does not dress up a cast that made nothing", () => {
    expect(castOutcome({ members: [member({ status: "error" })] })!.headline)
      .toBe("No Character could be cast from this recording.");
  });

  it("is absent for a job that was never a cast", () => {
    expect(castOutcome(null)).toBeNull();
    expect(castOutcome({ members: [] })).toBeNull();
  });
});
