import { describe, expect, it } from "vitest";

import { FEATURES, HERO } from "./content";
import { BENCHMARKS, HARNESS } from "./benchmarks";
import {
  NARRATABLE, clipKey, contentHash, hashParts, narratableFor, narrationPlan,
  speakable, splitSentences, taggedSentence,
} from "./narratable";

// The registry's whole value is that it cannot drift from the page and cannot
// drift from the cache. Both of those are hash claims, so they get tested.

describe("contentHash", () => {
  it("is stable for the same input", () => {
    expect(contentHash("the quick brown fox")).toBe(contentHash("the quick brown fox"));
  });

  it("changes when a single character changes", () => {
    expect(contentHash("hello world")).not.toBe(contentHash("hello worle"));
  });

  it("is order-sensitive (an anagram is a different hash)", () => {
    expect(contentHash("ab")).not.toBe(contentHash("ba"));
  });

  it("keeps fields apart — a key cannot collide across field boundaries", () => {
    // The bug this pins: joined with a space, ["a b", "c"] and ["a", "b c"] are
    // the same string, so two different narrator/sentence pairs would share one
    // cached clip and the page would speak in the wrong voice.
    expect(hashParts("a b", "c")).not.toBe(hashParts("a", "b c"));
  });

  it("is always 16 hex characters", () => {
    for (const s of ["", "a", "a much longer sentence with punctuation — yes."]) {
      expect(contentHash(s)).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("speakable", () => {
  it("replaces symbols that cannot be pronounced", () => {
    expect(speakable("1.9× faster")).toBe("1.9 times faster");
    expect(speakable("warm · en")).toBe("warm, en");
    expect(speakable("Open it →")).toBe("Open it then");
  });

  it("collapses the whitespace the replacements introduce", () => {
    expect(speakable("a  ·  b")).toBe("a, b");
  });
});

describe("splitSentences", () => {
  it("splits on sentence boundaries", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
  });

  it("drops empty fragments", () => {
    expect(splitSentences("   ")).toEqual([]);
  });

  it("splits an over-long sentence at a comma rather than shipping it whole", () => {
    const long = `${"word, ".repeat(40)}end.`;
    const parts = splitSentences(long, 120);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 130)).toBe(true);
    // Nothing is lost or duplicated by the split.
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(long.trim());
  });

  it("keeps a comma-less over-long sentence intact instead of cutting mid-word", () => {
    const long = `${"word ".repeat(60)}.`;
    expect(splitSentences(long, 80)).toHaveLength(1);
  });
});

describe("registry — both routes", () => {
  it("covers / and /benchmarks and nothing else", () => {
    expect(Object.keys(NARRATABLE).sort()).toEqual(["/", "/benchmarks"]);
  });

  it("resolves a trailing slash to the same route", () => {
    expect(narratableFor("/benchmarks/")).toBe(NARRATABLE["/benchmarks"]);
    expect(narratableFor("/")).toBe(NARRATABLE["/"]);
  });

  it("returns null for a route with nothing to say", () => {
    for (const p of ["/playground", "/keys", "/voices", "", null, undefined]) {
      expect(narratableFor(p)).toBeNull();
    }
  });

  it("gives every block a unique id, per route", () => {
    for (const route of Object.values(NARRATABLE)) {
      const ids = route.blocks.map((b) => b.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("never emits an empty block, an unspeakable symbol or a stray tag", () => {
    for (const route of Object.values(NARRATABLE)) {
      for (const b of route.blocks) {
        expect(b.text.length).toBeGreaterThan(10);
        expect(b.text).not.toMatch(/[×·→∞]/);
        expect(b.text).not.toMatch(/https?:\/\//); // never read a URL aloud
        expect(b.hash).toMatch(/^[0-9a-f]{16}$/);
        expect(b.emotionTag).toMatch(/^[a-z_]+$/);
      }
    }
  });

  it("hashes are unique across every block of both routes", () => {
    const hashes = Object.values(NARRATABLE).flatMap((r) => r.blocks.map((b) => b.hash));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("recomputes to the same hash — the registry is pure data", () => {
    for (const route of Object.values(NARRATABLE)) {
      for (const b of route.blocks) {
        expect(hashParts(b.role, b.emotionTag, b.text)).toBe(b.hash);
      }
    }
  });
});

describe("landing blocks are derived from lib/content", () => {
  const landing = NARRATABLE["/"];

  it("speaks the hero sub verbatim", () => {
    const hero = landing.blocks.find((b) => b.id === "hero");
    expect(hero?.text).toContain(speakable(HERO.sub));
    expect(hero?.role).toBe("hero");
  });

  it("has one block per feature, in source order", () => {
    const features = landing.blocks.filter((b) => b.role === "feature");
    expect(features.map((b) => b.id)).toEqual(FEATURES.map((f) => `feature-${f.key}`));
    features.forEach((b, i) => expect(b.text).toContain(speakable(FEATURES[i].body)));
  });

  it("uses the warm hint for the opening and the measured one for features", () => {
    expect(landing.blocks.find((b) => b.id === "hero")?.characterHint).toBe("warm");
    expect(landing.blocks.find((b) => b.role === "feature")?.characterHint).toBe("measured");
  });
});

describe("benchmark blocks are derived from lib/benchmarks", () => {
  const bench = NARRATABLE["/benchmarks"];

  it("has one block per measured row plus intro and methodology", () => {
    expect(bench.blocks.map((b) => b.id)).toEqual([
      "bench-intro",
      ...BENCHMARKS.map((b) => `bench-${b.id}`),
      "bench-method",
    ]);
  });

  it("quotes the harness facts, not a paraphrase", () => {
    const method = bench.blocks.find((b) => b.id === "bench-method");
    expect(method?.text).toContain(speakable(HARNESS.method));
    expect(method?.text).toContain(speakable(HARNESS.torch));
  });

  it("states a cost per audio-hour only for rows that have a price", () => {
    for (const row of BENCHMARKS) {
      const block = bench.blocks.find((b) => b.id === `bench-${row.id}`)!;
      expect(block.text.includes("per audio-hour")).toBe(row.usdPerHour != null);
    }
  });
});

describe("playback plan", () => {
  it("flattens every block into at least one sentence, in order", () => {
    for (const route of Object.values(NARRATABLE)) {
      const plan = narrationPlan(route);
      expect(plan.length).toBeGreaterThanOrEqual(route.blocks.length);
      expect([...new Set(plan.map((s) => s.blockIndex))]).toEqual(
        route.blocks.map((_, i) => i));
      // block indices never go backwards
      const indices = plan.map((s) => s.blockIndex);
      expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    }
  });

  it("wraps each sentence in its block's emotion metatag", () => {
    const step = narrationPlan(NARRATABLE["/"])[0];
    expect(taggedSentence(step.block, step.sentence))
      .toBe(`[${step.block.emotionTag}]${step.sentence}[/${step.block.emotionTag}]`);
  });
});

describe("clipKey", () => {
  const step = narrationPlan(NARRATABLE["/"])[0];

  it("is the same for the same narrator + sentence", () => {
    expect(clipKey("alba", step.block, step.sentence))
      .toBe(clipKey("alba", step.block, step.sentence));
  });

  it("differs per narrator — a cache hit is never the wrong voice", () => {
    expect(clipKey("alba", step.block, step.sentence))
      .not.toBe(clipKey("marius", step.block, step.sentence));
  });

  it("differs per emotion — a cache hit is never the wrong reading", () => {
    const other = { ...step.block, emotionTag: "calm" };
    expect(clipKey("alba", step.block, step.sentence))
      .not.toBe(clipKey("alba", other, step.sentence));
  });
});
