import { describe, expect, it } from "vitest";
import {
  appendEdit, composerLimit, composerWarnings, DEFAULT_EXPRESSION, MAX_SCRIPT_LINES, MAX_TEXT_CHARS, readEdits,
  scaleSegmentSeconds, segmentRegions, stripTags, type Segment, type Take,
} from "./shared";

const line = (text: string) => ({ text });

const seg = (text: string, seconds: number, over: Partial<Segment> = {}): Segment => ({
  text, requested: "baseline", used: "baseline", fallback: false,
  voice_id: "v1", seconds, ...over,
});

const take = (over: Partial<Take> = {}): Take => ({
  id: "take-1", text: "hi", characterId: "sarah", characterName: "Sarah",
  mode: "gravitone", peaks: [], seconds: 3, kb: 1, rtf: 1,
  synthSeconds: 0, queueSeconds: 0, ignoredSettings: [], segments: [],
  expr: DEFAULT_EXPRESSION, createdAt: 1, ...over,
});

describe("composerLimit — the ceiling, before the request", () => {
  it("passes an ordinary take", () => {
    expect(composerLimit({ mode: "solo", text: "hello there", script: [] })).toBeNull();
  });

  it("counts metatags: the backend measures the raw text, not the spoken words", () => {
    // stripTags() is the right length for the AUDIO estimate and the wrong one
    // for the limit — the tags are sent.
    const tagged = `[excited]${"a".repeat(MAX_TEXT_CHARS - 10)}[/excited]`;
    expect(stripTags(tagged).length).toBeLessThan(MAX_TEXT_CHARS);
    expect(composerLimit({ mode: "solo", text: tagged, script: [] })).toMatch(/over the/);
  });

  it("says how far over the solo limit the text is", () => {
    const msg = composerLimit({ mode: "solo", text: "a".repeat(MAX_TEXT_CHARS + 5), script: [] });
    expect(msg).toContain("5 over");
  });

  it("names the offending script line", () => {
    const msg = composerLimit({
      mode: "script", text: "",
      script: [line("ok"), line("b".repeat(MAX_TEXT_CHARS + 1))],
    });
    expect(msg).toMatch(/^Line 2 /);
  });

  it("blocks a script past the engine's line cap", () => {
    const msg = composerLimit({
      mode: "script", text: "",
      script: Array.from({ length: MAX_SCRIPT_LINES + 1 }, () => line("hi")),
    });
    expect(msg).toContain(`at most ${MAX_SCRIPT_LINES}`);
  });

  it("blocks a body the studio's proxy would reject with a bare 413", () => {
    // Every line is legal on its own; together they exceed the 128 KB the proxy
    // forwards, which used to surface as "request body too large" and nothing
    // about which line to shorten.
    const msg = composerLimit({
      mode: "script", text: "",
      script: Array.from({ length: 40 }, () => line("c".repeat(4000))),
    });
    expect(msg).toMatch(/KB/);
  });

  it("ignores the script while in solo mode, and the solo text while in script mode", () => {
    const huge = [line("d".repeat(MAX_TEXT_CHARS + 1))];
    expect(composerLimit({ mode: "solo", text: "fine", script: huge })).toBeNull();
    expect(composerLimit({ mode: "script", text: "e".repeat(MAX_TEXT_CHARS + 1), script: [line("fine")] })).toBeNull();
  });
});

// ── the punch-in editor's arithmetic ─────────────────────────────────────────

describe("segmentRegions — where each segment IS", () => {
  it("places segments end to end from their reported seconds", () => {
    const r = segmentRegions([seg("one", 1), seg("two", 2), seg("three", 1)], 4);
    expect(r.map((x) => [x.start, x.end])).toEqual([[0, 1], [1, 3], [3, 4]]);
  });

  it("scales the report onto the DECODED duration", () => {
    // The engine trims and concatenates, so the reported seconds sum to a little
    // less (or more) than the audio. Unscaled, that error accumulates until a
    // click near the end of a long performance seeks past the take.
    const r = segmentRegions([seg("a", 1), seg("b", 1), seg("c", 1)], 6);
    expect(r[0].end).toBeCloseTo(2, 6);
    expect(r[2].end).toBe(6);
  });

  it("always ends the LAST region exactly at the duration", () => {
    const r = segmentRegions([seg("a", 0.333), seg("b", 0.333), seg("c", 0.333)], 5);
    expect(r[r.length - 1].end).toBe(5);
  });

  it("divides evenly when the report carries no usable seconds", () => {
    // A guess about WHERE, never a claim about how long it took to say.
    const r = segmentRegions([seg("a", 0), seg("b", 0)], 4);
    expect(r.map((x) => [x.start, x.end])).toEqual([[0, 2], [2, 4]]);
  });

  it("has no regions without segments or without a duration", () => {
    expect(segmentRegions([], 5)).toEqual([]);
    expect(segmentRegions([seg("a", 1)], 0)).toEqual([]);
  });

  it("keeps each region's own segment, so a click knows what it clicked", () => {
    const r = segmentRegions([seg("one", 1), seg("two", 1, { characterId: "bo" })], 2);
    expect(r[1].segment.characterId).toBe("bo");
    expect(r[1].index).toBe(1);
  });
});

describe("scaleSegmentSeconds", () => {
  it("re-bases a fragment's report onto what it actually decoded to", () => {
    const out = scaleSegmentSeconds([seg("a", 1), seg("b", 3)], 2);
    expect(out.map((s) => s.seconds)).toEqual([0.5, 1.5]);
  });

  it("splits the duration evenly when nothing was reported", () => {
    expect(scaleSegmentSeconds([seg("a", 0), seg("b", 0)], 3).map((s) => s.seconds))
      .toEqual([1.5, 1.5]);
  });

  it("leaves the report alone when there is no duration to trust", () => {
    expect(scaleSegmentSeconds([seg("a", 2)], 0)[0].seconds).toBe(2);
  });
});

describe("take edits (D5) — provenance that survives storage", () => {
  it("names the base take and the patched region", () => {
    const e = appendEdit(take({ id: "base-1" }), { i: 2, text: "[sad]again[/sad]", emotion: "sad" });
    expect(e).toEqual({
      v: 1, source: "base-1",
      regions: [{ i: 2, text: "[sad]again[/sad]", emotion: "sad" }],
    });
  });

  it("keeps the ORIGINAL take as the source across repeated punches", () => {
    // A chain of ids would have left the code export unable to print the recipe
    // once the intermediate takes aged out of the log.
    const first = appendEdit(take({ id: "base-1" }), { i: 0, text: "one" });
    const second = appendEdit(take({ id: "spliced-1", edits: first }), { i: 1, text: "two" });
    expect(second.source).toBe("base-1");
    expect(second.regions.map((r) => r.text)).toEqual(["one", "two"]);
  });

  it("round-trips through structured clone (the IndexedDB write)", () => {
    const t = take({ id: "spliced-1", edits: appendEdit(take({ id: "base-1" }), { i: 1, text: "two" }) });
    const stored = structuredClone({ take: { ...t, url: undefined, blob: undefined } });
    expect(readEdits(stored.take)).toEqual({ v: 1, source: "base-1", regions: [{ i: 1, text: "two" }] });
  });

  it("restores a record written before the editor existed", () => {
    // Takes are durable, so the console reads records from builds that had no
    // `edits` field at all. "No history" is not a reason to lose the take.
    expect(readEdits(take())).toBeNull();
    expect(readEdits(undefined)).toBeNull();
    expect(readEdits({})).toBeNull();
  });

  it("ignores a version this build does not understand", () => {
    expect(readEdits({ edits: { v: 99, source: "base-1", regions: [{ i: 0, text: "x" }] } })).toBeNull();
  });

  it("drops malformed regions instead of trusting them into the splice", () => {
    const got = readEdits({
      edits: { v: 1, source: "base-1", regions: [{ i: 0, text: "ok" }, { i: "nope", text: 1 }, null] },
    });
    expect(got?.regions).toEqual([{ i: 0, text: "ok" }]);
  });
});

// ── the lint: what these tags will DO ────────────────────────────────────────
// composerLimit refuses what the SERVER refuses. These are the things the
// server accepts and then does something unwanted with — above all a malformed
// tag, which is not an error at all: it does not match the service's tag regex,
// so it stays in the text and is SPOKEN OUT LOUD.

describe("composerWarnings — named outcomes before the render", () => {
  const scale = ["baseline", "calm", "happy", "excited", "sad"];
  const solo = (text: string, known = scale) =>
    composerWarnings({ mode: "solo", text, script: [], known }).map((w) => w.message);

  it("says nothing about a clean take", () => {
    expect(solo("Hello. [excited]This is amazing![/excited] Bye.")).toEqual([]);
    expect(solo("no tags at all")).toEqual([]);
  });

  it("says a malformed tag will be spoken out loud", () => {
    // `[x[/x]` is exactly what a backspace inside an empty pair used to leave.
    expect(solo("[x[/x]hi").join(" ")).toMatch(/spoken out loud/);
    expect(solo("say [excited this").join(" ")).toMatch(/unmatched \[.*spoken out loud/);
    expect(solo("[battle-cry]charge").join(" ")).toMatch(/"\[battle-cry\]".*spoken out loud/);
  });

  it("does NOT call a digit-bearing name malformed — the engine reads it now", () => {
    expect(solo("[mode2]hi[/mode2]", [...scale, "mode2"])).toEqual([]);
  });

  it("says an unclosed tag runs to the end of the text", () => {
    expect(solo("Calm. [sad]then everything went wrong.").join(" "))
      .toMatch(/\[sad\] is never closed — it runs to the end of the text/);
  });

  it("does not report a tag that IS closed, or one closed by a later tag", () => {
    expect(solo("[sad]a[/sad]b")).toEqual([]);
    expect(solo("[sad]a[/]b")).toEqual([]);
    expect(solo("a[sad]b[happy]c[/happy]")).toEqual([]);
  });

  it("says an unknown name is not recorded and will be substituted", () => {
    const msg = solo("[excitedd]hi[/excitedd]").join(" ");
    expect(msg).toMatch(/\[excitedd\] is not an emotion on this Character's scale/);
    expect(msg).toMatch(/nearest match will be used/);
  });

  it("accepts a CUSTOM slot that is on the scale", () => {
    expect(solo("[battle_cry]charge[/battle_cry]", [...scale, "battle_cry"])).toEqual([]);
  });

  it("keeps quiet about vocabulary when it has none to check against", () => {
    // A console that has not loaded a roster must not call every tag a typo.
    expect(composerWarnings({ mode: "solo", text: "[excited]hi[/excited]", script: [] })).toEqual([]);
  });

  it("says a [baseline] tag is the absence of direction spelled as one", () => {
    expect(solo("[baseline]hi[/baseline]").join(" "))
      .toMatch(/absence of direction spelled as a direction/);
  });

  it("reports each distinct mistake once, however often it is made", () => {
    expect(solo("[excitedd]a[/excitedd] [excitedd]b[/excitedd]")).toHaveLength(1);
    expect(solo("[excitedd]a[/excitedd] [saddd]b[/saddd]")).toHaveLength(2);
  });

  it("is the SAME lint in script mode, with the line named", () => {
    const got = composerWarnings({
      mode: "script",
      text: "",
      script: [{ text: "fine" }, { text: "[sad]runs on" }],
      known: scale,
    });
    expect(got).toHaveLength(1);
    expect(got[0].message).toMatch(/^Line 2 — \[sad\] is never closed/);
  });

  it("ignores a script line with nothing on it", () => {
    expect(composerWarnings({ mode: "script", text: "", script: [{ text: "   " }], known: scale }))
      .toEqual([]);
  });

  it("reads the mode it is given, not the field that happens to be filled", () => {
    const both = { text: "[bogus]a", script: [{ text: "[alsobogus]b" }], known: scale };
    const asSolo = composerWarnings({ mode: "solo", ...both }).map((w) => w.message).join();
    expect(asSolo).toMatch(/bogus/);
    expect(asSolo).not.toMatch(/alsobogus/);
    expect(composerWarnings({ mode: "script", ...both }).map((w) => w.message).join())
      .toMatch(/alsobogus/);
  });
});
