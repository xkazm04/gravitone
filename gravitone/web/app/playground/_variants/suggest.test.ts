import { describe, expect, it } from "vitest";
import {
  accept, asRegion, fallbackNote, heuristicDirector, propose, proposalSummary, REASONS,
  reject, retag, sentences, type Director, type Suggestion,
} from "./suggest";
import { parseTags, scoreRegion } from "./shared";

// This pass reads punctuation, capitals and brackets. It does not read MEANING,
// and the tests are written to hold it to exactly that: every assertion below
// is about the shape of the writing, and the negative cases are the ones that
// keep it from drifting into claims it cannot support.

const SCALE = ["baseline", "calm", "happy", "excited", "sad", "angry", "whisper", "confused"];

/** The words a suggestion covers — the only thing that matters about its
 *  offsets, and far more readable than the numbers. */
const covered = (text: string, list: Suggestion[]) => list.map((s) => text.slice(s.start, s.end));

describe("sentences — the coordinate space every rule works in", () => {
  it("splits on terminators and keeps offsets into the ORIGINAL text", () => {
    const text = "One. Two! Three?";
    expect(sentences(text).map((s) => text.slice(s.start, s.end))).toEqual(["One.", "Two!", "Three?"]);
  });

  it("keeps a final sentence that never got a terminator", () => {
    const text = "Finished. Still going";
    expect(sentences(text).map((s) => text.slice(s.start, s.end))).toEqual(["Finished.", "Still going"]);
  });

  it("treats a newline as an ending, and never emits whitespace as a sentence", () => {
    const text = "First line\n\nSecond line";
    expect(sentences(text).map((s) => text.slice(s.start, s.end))).toEqual(["First line", "Second line"]);
  });

  it("has nothing to say about an empty or blank text", () => {
    expect(sentences("")).toEqual([]);
    expect(sentences("   \n  ")).toEqual([]);
  });
});

describe("heuristicDirector — the rules, and only the rules", () => {
  it("proposes excited for a sentence that ends in an exclamation", () => {
    const text = "Hello there. This part is amazing!";
    const out = heuristicDirector(text, SCALE);
    expect(covered(text, out)).toEqual(["This part is amazing!"]);
    expect(out[0]).toMatchObject({ value: "excited", reason: "exclamation" });
  });

  it("proposes confused for a question", () => {
    const text = "Are you sure about that?";
    expect(heuristicDirector(text, SCALE)[0]).toMatchObject({ value: "confused", reason: "question" });
  });

  it("proposes sad for a sentence that trails off", () => {
    const text = "I suppose it was always going to end...";
    expect(heuristicDirector(text, SCALE)[0]).toMatchObject({ value: "sad", reason: "ellipsis" });
  });

  it("proposes whisper for a bracketed aside, and only the bracketed part", () => {
    const text = "She left the room (or so everyone assumed) without a word.";
    const out = heuristicDirector(text, SCALE);
    expect(covered(text, out)).toEqual(["(or so everyone assumed)"]);
    expect(out[0]).toMatchObject({ value: "whisper", reason: "parenthetical" });
  });

  it("proposes angry for capitals, beating the exclamation mark that ends them", () => {
    const text = "GET OUT OF THERE!";
    const out = heuristicDirector(text, SCALE);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ value: "angry", reason: "shout" });
  });

  it("does not call a single capitalised word a shout — that is an acronym", () => {
    expect(heuristicDirector("The API is down.", SCALE)).toEqual([]);
    expect(heuristicDirector("NASA confirmed it.", SCALE)).toEqual([]);
  });

  it("says nothing at all about ordinary prose", () => {
    // Low recall is the POINT. Twelve suggestions where half are noise cost
    // more attention to audit than they save.
    expect(heuristicDirector("The report landed on Tuesday. It was thorough and dull.", SCALE)).toEqual([]);
  });

  it("does not cut at a terminator that a lowercase word continues", () => {
    // "He said stop! and then walked away." is one thought. Cutting at the "!"
    // would tag the fragment "He said stop!" as though the writer had finished,
    // and this pass is not confident enough to cut clauses.
    expect(heuristicDirector("He said stop! and then walked away.", SCALE)).toEqual([]);
    expect(heuristicDirector("It was over (!!!) and that was that.", SCALE)).toEqual([]);
  });

  it("never overlaps: a bracketed aside inside an exclaimed sentence wins outright", () => {
    const text = "It was over (finally) and everyone cheered!";
    const out = heuristicDirector(text, SCALE);
    expect(covered(text, out)).toEqual(["(finally)"]);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
  });

  it("returns suggestions in reading order whatever order the rules found them", () => {
    const text = "Where did it go? THIS IS RIDICULOUS. And then (quietly) it reappeared!";
    const out = heuristicDirector(text, SCALE);
    expect(out.map((s) => s.start)).toEqual([...out.map((s) => s.start)].sort((a, b) => a - b));
    expect(out.map((s) => s.reason)).toEqual(["question", "shout", "parenthetical"]);
  });

  it("proposes NOTHING an emotion the Character's scale cannot address", () => {
    // A tag for an emotion that is on no scale is a typo the composer would
    // have to refuse — better never to have offered it.
    const text = "This part is amazing! And where did it go?";
    expect(heuristicDirector(text, ["baseline", "confused"]).map((s) => s.value)).toEqual(["confused"]);
    expect(heuristicDirector(text, ["baseline"])).toEqual([]);
  });

  it("skips a span too short to be worth a Voice switch", () => {
    expect(heuristicDirector("Hi! Ok?", SCALE)).toEqual([]);
  });

  it("skips a bracketed aside with no words in it", () => {
    // No sentence terminator anywhere here, so the parenthetical rule is the
    // only one in play — and punctuation alone is not an aside.
    expect(heuristicDirector("Look over here (!!!) right now", SCALE)).toEqual([]);
  });

  it("names a reason for every suggestion it makes", () => {
    const text = "Really? YES REALLY. It was over (at last) and I shouted!";
    for (const s of heuristicDirector(text, SCALE)) expect(REASONS[s.reason]).toBeTruthy();
  });

  it("stays linear and disjoint at the 8000-character cap", () => {
    const text = "This is amazing! ".repeat(470).slice(0, 8000);
    const out = heuristicDirector(text, SCALE);
    expect(out.length).toBeGreaterThan(100);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
    expect(out.every((s) => s.end <= text.length)).toBe(true);
  });
});

describe("propose — the director is a seam, not a hard-coded rule set", () => {
  it("accepts any Director with the same signature", () => {
    const stub: Director = (plain) => [{ start: 0, end: 4, value: "calm", reason: "question" }];
    expect(propose("word here", SCALE, [], stub)).toEqual([
      { start: 0, end: 4, value: "calm", reason: "question" },
    ]);
  });

  it("never second-guesses words the user has already directed", () => {
    const text = "This part is amazing!";
    const existing = [scoreRegion(0, 21, "whisper")];
    expect(propose(text, SCALE, existing)).toEqual([]);
  });

  it("keeps a suggestion that merely sits NEXT TO an existing region", () => {
    const text = "Calm words. This part is amazing!";
    expect(propose(text, SCALE, [scoreRegion(0, 11, "calm")])).toHaveLength(1);
  });
});

describe("the accept / reject state machine", () => {
  const TEXT = "Where did it go? This part is amazing!";
  const open = () => propose(TEXT, SCALE, []);

  it("proposes without touching the string — nothing is auto-applied", () => {
    const list = open();
    expect(list).toHaveLength(2);
    // The composer's value is the caller's; `propose` is pure and returns only
    // the proposal. Nothing here can reach the engine.
    expect(parseTags(TEXT).regions).toEqual([]);
  });

  it("accepts one suggestion into the string as an ordinary region", () => {
    const list = open();
    const { next, applied, refused } = accept(TEXT, list, [0]);
    expect(applied).toBe(1);
    expect(refused).toEqual([]);
    expect(next).toBe("[confused]Where did it go?[/confused] This part is amazing!");
    // Exactly what a hand-placed region looks like — same parse, same shape.
    expect(parseTags(next).regions).toEqual([scoreRegion(0, 16, "confused")]);
    expect(parseTags(next).text).toBe(TEXT);
  });

  it("accepts all of them, and the offsets of the later ones still land", () => {
    const list = open();
    const { next, applied } = accept(TEXT, list, list.map((_, i) => i));
    expect(applied).toBe(2);
    expect(parseTags(next).regions).toEqual([
      scoreRegion(0, 16, "confused"),
      scoreRegion(17, 38, "excited"),
    ]);
    expect(parseTags(next).text).toBe(TEXT);
  });

  it("reports a refusal in the composer's own words instead of counting it as applied", () => {
    // A suggestion that would overlap an existing region cannot be placed — the
    // grammar has no nesting — and the count must not claim otherwise.
    const tagged = "[whisper]Where did it go?[/whisper] This part is amazing!";
    const list = open();
    const { applied, refused } = accept(tagged, list, [0, 1]);
    expect(applied).toBe(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].why).toMatch(/overlaps the whisper region/);
  });

  it("rejects one and leaves the rest, touching nothing", () => {
    const list = open();
    const after = reject(list, 0);
    expect(after).toHaveLength(1);
    expect(after[0].reason).toBe("exclamation");
    expect(list).toHaveLength(2); // pure: the original is not mutated
  });

  it("re-aims one at another emotion, keeping the span and the reason", () => {
    const list = open();
    const after = retag(list, 1, "angry");
    expect(after[1]).toMatchObject({ value: "angry", reason: "exclamation", start: list[1].start, end: list[1].end });
    expect(list[1].value).toBe("excited"); // pure
  });

  it("applies a re-aimed suggestion as the emotion the user chose", () => {
    const list = retag(open(), 1, "angry");
    const { next } = accept(TEXT, list, [1]);
    expect(next).toBe("Where did it go? [angry]This part is amazing![/angry]");
  });

  it("accepting an index that is not selected leaves it alone", () => {
    const list = open();
    const { next, applied } = accept(TEXT, list, []);
    expect(applied).toBe(0);
    expect(next).toBe(TEXT);
  });

  it("draws each suggestion as exactly the region it would place", () => {
    const list = open();
    expect(asRegion(list[0])).toEqual(scoreRegion(list[0].start, list[0].end, list[0].value));
  });
});

describe("what the user is told", () => {
  it("states the METHOD rather than implying comprehension", () => {
    expect(proposalSummary(3)).toMatch(/from punctuation and phrasing/);
    expect(proposalSummary(3)).toMatch(/not a reading/);
    expect(proposalSummary(1)).toMatch(/^1 suggestion /);
  });

  it("explains an empty result by naming what it looked for", () => {
    expect(proposalSummary(0)).toMatch(/punctuation, capitals and brackets/);
  });

  it("marks the fallback consequence in composerWarnings' own words", () => {
    expect(fallbackNote("excited", ["baseline", "calm"]))
      .toBe("Excited is not recorded for this Character — the nearest recorded emotion is used, then baseline.");
  });

  it("says nothing when the emotion IS recorded, or when nothing is known", () => {
    expect(fallbackNote("excited", ["baseline", "excited"])).toBeNull();
    expect(fallbackNote("excited", [])).toBeNull();
  });
});
