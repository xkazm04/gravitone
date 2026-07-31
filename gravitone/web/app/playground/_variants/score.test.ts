import { describe, expect, it } from "vitest";
import {
  normalizeRegions, parseTags, regionProblem, scoreRegion, toTags, transformRegions,
  type ScoreRegion,
} from "./shared";

// The score model's whole job is to be a LOSSLESS view of a string the engine
// already understands. If the round-trip is wrong the user does not get a
// slightly odd editor — they get a prompt that says something else. So both
// directions are pinned here, edge cases first.

const r = scoreRegion;

/** Round-trip a tagged string through the model and back. */
const rebuild = (tagged: string) => {
  const { text, regions } = parseTags(tagged);
  return toTags(text, regions);
};

describe("parseTags — the grammar, exactly as the service reads it", () => {
  it("lifts a tagged span into a region over the PLAIN text", () => {
    const { text, regions } = parseTags("Hello. [excited]This is amazing![/excited] Bye.");
    expect(text).toBe("Hello. This is amazing! Bye.");
    expect(regions).toEqual([r(7, 23, "excited")]);
    expect(text.slice(7, 23)).toBe("This is amazing!");
  });

  it("returns plain text untouched and unregioned", () => {
    expect(parseTags("just words")).toEqual({ text: "just words", regions: [] });
  });

  it("does NOT nest: a closing tag returns to baseline, not to the enclosing tag", () => {
    // service/emotions.py: `current = BASELINE if closing or not name else name`.
    // Rendering `z` as `angry` here would be the UI inventing a grammar the
    // engine does not have.
    const { text, regions } = parseTags("[angry]x[whisper]y[/whisper]z[/angry]");
    expect(text).toBe("xyz");
    expect(regions).toEqual([r(0, 1, "angry"), r(1, 2, "whisper")]);
  });

  it("runs an unclosed tag to the next tag and to the end of the text", () => {
    const { text, regions } = parseTags("a[sad]b[happy]c");
    expect(text).toBe("abc");
    expect(regions).toEqual([r(1, 2, "sad"), r(2, 3, "happy")]);
  });

  it("treats [] and [/] as a return to baseline", () => {
    expect(parseTags("[sad]a[]b").regions).toEqual([r(0, 1, "sad")]);
    expect(parseTags("[sad]a[/]b").regions).toEqual([r(0, 1, "sad")]);
  });

  it("keeps adjacent regions apart instead of merging them", () => {
    const { text, regions } = parseTags("[sad]one[/sad][happy]two[/happy]");
    expect(text).toBe("onetwo");
    expect(regions).toEqual([r(0, 3, "sad"), r(3, 6, "happy")]);
  });

  it("produces no region for an empty span", () => {
    expect(parseTags("[sad][/sad]hello").regions).toEqual([]);
    expect(parseTags("[sad][happy]hi[/happy]").regions).toEqual([r(0, 2, "happy")]);
  });

  it("produces no region for baseline itself — baseline is the absence of one", () => {
    expect(parseTags("[baseline]hello[/baseline]").regions).toEqual([]);
    expect(parseTags("[baseline]hello[/baseline]").text).toBe("hello");
  });

  it("lower-cases a tag name the way the service does", () => {
    expect(parseTags("[EXCITED]hi[/EXCITED]").regions).toEqual([r(0, 2, "excited")]);
  });

  it("keeps whitespace the text actually has (only stripTags collapses it)", () => {
    expect(parseTags("  [sad]a  b[/sad]  ").text).toBe("  a  b  ");
  });

  it("has no regex state to leak between calls", () => {
    const once = parseTags("[sad]a[/sad]");
    expect(parseTags("[sad]a[/sad]")).toEqual(once);
  });
});

describe("toTags — back to the wire format", () => {
  it("writes a region as the inline pair", () => {
    expect(toTags("Hello. This is amazing! Bye.", [r(7, 23, "excited")]))
      .toBe("Hello. [excited]This is amazing![/excited] Bye.");
  });

  it("writes nothing for no regions", () => {
    expect(toTags("plain", [])).toBe("plain");
  });

  it("writes adjacent regions back to back", () => {
    expect(toTags("onetwo", [r(0, 3, "sad"), r(3, 6, "happy")]))
      .toBe("[sad]one[/sad][happy]two[/happy]");
  });

  it("orders regions by position however they were handed over", () => {
    expect(toTags("onetwo", [r(3, 6, "happy"), r(0, 3, "sad")]))
      .toBe("[sad]one[/sad][happy]two[/happy]");
  });

  it("drops an empty region rather than writing a tag pair around nothing", () => {
    expect(toTags("hello", [r(2, 2, "sad")])).toBe("hello");
  });

  it("clamps a region that runs past the end of the text", () => {
    expect(toTags("hi", [r(0, 99, "sad")])).toBe("[sad]hi[/sad]");
  });

  it("drops the second of two overlapping regions — the grammar cannot nest", () => {
    expect(toTags("abcdef", [r(0, 4, "sad"), r(2, 6, "happy")])).toBe("[sad]abcd[/sad]ef");
  });

  it("drops a region the tag grammar cannot carry instead of emitting a broken tag", () => {
    // `mode2` is a legal emotion slug and an illegal tag name — see TAGGABLE.
    expect(toTags("abc", [r(0, 3, "mode2")])).toBe("abc");
    expect(toTags("abc", [r(0, 3, "baseline")])).toBe("abc");
  });
});

describe("round-trip — both directions, because a drift here rewrites the prompt", () => {
  const CASES: Array<[string, string]> = [
    ["plain text", "plain text"],
    ["[sad]all of it[/sad]", "[sad]all of it[/sad]"],
    ["Hello. [excited]wow![/excited] Bye.", "Hello. [excited]wow![/excited] Bye."],
    ["[sad]one[/sad][happy]two[/happy]", "[sad]one[/sad][happy]two[/happy]"],
    // normalising rewrites, and then holds still
    ["[angry]x[whisper]y[/whisper]z[/angry]", "[angry]x[/angry][whisper]y[/whisper]z"],
    ["a[sad]b[happy]c", "a[sad]b[/sad][happy]c[/happy]"],
    ["[sad][/sad]hello", "hello"],
    ["[baseline]hello[/baseline]", "hello"],
    ["[EXCITED]hi[/EXCITED]", "[excited]hi[/excited]"],
    ["", ""],
  ];

  it.each(CASES)("string -> model -> string: %s", (input, expected) => {
    expect(rebuild(input)).toBe(expected);
    // and the normalised form is a fixed point
    expect(rebuild(expected)).toBe(expected);
  });

  it("model -> string -> model is the identity for writable regions", () => {
    const text = "Hello. This is amazing! Bye.";
    const regions = [r(0, 5, "calm"), r(7, 23, "excited")];
    expect(parseTags(toTags(text, regions))).toEqual({ text, regions });
  });

  it("never loses a character of the text", () => {
    const tagged = "  [sad]a  b[/sad] tail [happy]c[/happy]";
    const { text } = parseTags(tagged);
    expect(parseTags(rebuild(tagged)).text).toBe(text);
  });
});

describe("regionProblem — a refusal the user can read", () => {
  const text = "hello world";
  it("passes an ordinary region", () => {
    expect(regionProblem(text, r(0, 5, "sad"))).toBeNull();
  });
  it("refuses an empty selection", () => {
    expect(regionProblem(text, r(3, 3, "sad"))).toMatch(/at least one character/);
  });
  it("refuses a region outside the text", () => {
    expect(regionProblem(text, r(0, 99, "sad"))).toMatch(/outside the text/);
  });
  it("refuses baseline as a value and says what to do instead", () => {
    expect(regionProblem(text, r(0, 5, "baseline"))).toMatch(/delete the region/);
  });
  it("names an emotion the tag grammar cannot carry", () => {
    expect(regionProblem(text, r(0, 5, "mode2"))).toMatch(/cannot be written as an inline tag/);
  });
  it("names the region it would overlap", () => {
    const others = [r(0, 5, "sad")];
    expect(regionProblem(text, r(3, 8, "happy"), others)).toMatch(/overlaps the sad region/);
  });
  it("does not report a region as overlapping itself", () => {
    const mine = r(0, 5, "sad");
    expect(regionProblem(text, mine, [mine])).toBeNull();
  });
});

describe("normalizeRegions", () => {
  it("keeps whole-character bounds only", () => {
    expect(normalizeRegions("abcdef", [{ start: 0.5, end: 3, kind: "emotion", value: "sad" } as ScoreRegion]))
      .toEqual([]);
  });
  it("clamps a negative start onto the text", () => {
    expect(normalizeRegions("abc", [r(-4, 2, "sad")])).toEqual([r(0, 2, "sad")]);
  });
});

// ── the edit matrix ─────────────────────────────────────────────────────────
// M2's named risk: "offset-based regions are fragile under text edits — need an
// edit-transform pass or regions silently drift onto wrong words". Each case
// below is one cell of that matrix, and the last group is the one that must
// CLEAR rather than guess.

describe("transformRegions — regions survive an edit or are cleared by name", () => {
  const before = "one two three";
  const region = r(4, 7, "sad"); // "two"

  const shifted = (after: string) => transformRegions([region], before, after);

  it("does nothing at all when the text did not change", () => {
    expect(shifted(before)).toEqual({ regions: [region], cleared: [] });
  });

  it("shifts a region right when text is inserted before it", () => {
    const got = shifted("AND one two three");
    expect(got.cleared).toEqual([]);
    expect(got.regions).toEqual([r(8, 11, "sad")]);
    expect("AND one two three".slice(8, 11)).toBe("two");
  });

  it("shifts a region left when text is deleted before it", () => {
    const got = shifted("two three");
    expect(got.cleared).toEqual([]);
    expect(got.regions).toEqual([r(0, 3, "sad")]);
    expect("two three".slice(0, 3)).toBe("two");
  });

  it("leaves a region alone when the edit is entirely after it", () => {
    const got = shifted("one two THREE");
    expect(got).toEqual({ regions: [region], cleared: [] });
  });

  it("keeps the region on its own words when text is inserted at its right edge", () => {
    const got = shifted("one two! three");
    expect(got.regions).toEqual([r(4, 7, "sad")]);
    expect("one two! three".slice(4, 7)).toBe("two");
  });

  it("keeps the region on its own words when text is inserted at its left edge", () => {
    const got = shifted("one ~two three");
    expect(got.regions).toEqual([r(5, 8, "sad")]);
    expect("one ~two three".slice(5, 8)).toBe("two");
  });

  it("grows the region around a pure insertion INSIDE it", () => {
    // Nothing the region covered changed, so this cannot land on other words.
    const got = shifted("one tXwo three");
    expect(got.cleared).toEqual([]);
    expect(got.regions).toEqual([r(4, 8, "sad")]);
    expect("one tXwo three".slice(4, 8)).toBe("tXwo");
  });

  it("leaves an APPENDED character outside the region rather than guessing", () => {
    // "two" -> "twoo" is genuinely ambiguous under a prefix/suffix diff: the new
    // `o` could have been typed at either edge of the repeat. The transform
    // takes the earliest insertion point, so the region keeps exactly the words
    // it had — the conservative read, not a guess that grows the direction.
    const got = shifted("one twoo three");
    expect(got.cleared).toEqual([]);
    expect(got.regions).toEqual([r(4, 7, "sad")]);
    expect("one twoo three".slice(4, 7)).toBe("two");
  });

  it("CLEARS the region when its own words are replaced", () => {
    const got = shifted("one six three");
    expect(got.regions).toEqual([]);
    expect(got.cleared).toEqual([region]);
  });

  it("CLEARS the region when its own words are deleted", () => {
    const got = shifted("one  three");
    expect(got.regions).toEqual([]);
    expect(got.cleared).toEqual([region]);
  });

  it("CLEARS the region when an edit swallows it whole", () => {
    const got = shifted("rewritten");
    expect(got.cleared).toEqual([region]);
  });

  it("CLEARS only the region that was touched, and shifts the rest", () => {
    const regions = [r(0, 3, "calm"), r(4, 7, "sad"), r(8, 13, "happy")];
    const got = transformRegions(regions, before, "one SIX three");
    expect(got.cleared).toEqual([r(4, 7, "sad")]);
    expect(got.regions).toEqual([r(0, 3, "calm"), r(8, 13, "happy")]);
  });

  it("clears a region when the whole text is emptied", () => {
    const got = shifted("");
    expect(got.regions).toEqual([]);
    expect(got.cleared).toEqual([region]);
  });

  it("clamps a survivor that the edit pushed past the end of the text", () => {
    // Deleting the tail shortens the text under a region that started after it.
    const got = transformRegions([r(8, 13, "happy")], before, "one two");
    expect(got.regions).toEqual([]);
    expect(got.cleared).toEqual([r(8, 13, "happy")]);
  });

  it("never leaves a region pointing outside the new text", () => {
    const regions = [r(0, 3, "calm"), r(4, 7, "sad"), r(8, 13, "happy")];
    for (const after of ["", "o", "one two three four", "xyz", "one two three"]) {
      for (const got of transformRegions(regions, before, after).regions) {
        expect(got.start).toBeGreaterThanOrEqual(0);
        expect(got.end).toBeLessThanOrEqual(after.length);
        expect(got.end).toBeGreaterThan(got.start);
      }
    }
  });
});
