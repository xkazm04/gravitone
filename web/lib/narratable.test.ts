import { describe, expect, it } from "vitest";

import { FEATURES, HERO } from "./content";
import { BENCHMARKS, HARNESS } from "./benchmarks";
import {
  NARRATABLE, bakedUrl, clipKey, contentHash, hashParts, narratableFor,
  narrationPlan, parseManifest, routeFromPlan, speakable, splitSentences,
  taggedSentence,
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

// ── the /v1/narrate seam ─────────────────────────────────────────────────────
//
// A plan arrives over the network. Everything below is about refusing the parts
// of it that cannot be played, rather than pushing them at a synthesis route
// and finding out there.

describe("routeFromPlan", () => {
  const plan = {
    narration_id: "abc123",
    title: "A customer page",
    blocks: [
      { id: "b000", label: "Intro", text: "Hello there.", emotion: "excited",
        character_hint: "warm", hash: "0123456789abcdef", role: "lead" },
      { id: "b001", label: "Body", text: "It reads pages aloud.", emotion: "baseline",
        character_hint: "measured", role: "body" },
    ],
  };

  it("becomes a route the existing transport can play", () => {
    const route = routeFromPlan(plan)!;
    expect(route.route).toBe("narration:abc123");
    expect(route.title).toBe("A customer page");
    expect(route.blocks).toHaveLength(2);
    expect(route.blocks[0]).toMatchObject({
      emotionTag: "excited", characterHint: "warm", role: "hero",
    });
    expect(route.blocks[1].characterHint).toBe("measured");
  });

  it("carries no anchor — there is nothing on this page to highlight", () => {
    for (const block of routeFromPlan(plan)!.blocks) {
      expect(block.anchor).toBeUndefined();
    }
  });

  it("keeps the service's hash so a baked clip stays addressable", () => {
    expect(routeFromPlan(plan)!.blocks[0].hash).toBe("0123456789abcdef");
  });

  it("computes a hash for a block that arrived without one", () => {
    expect(routeFromPlan(plan)!.blocks[1].hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("DROPS a block whose emotion is not an emotion name", () => {
    // The bug this pins: an injected tag name would be interpolated straight
    // into `[${tag}]...[/${tag}]` and posted at the relay.
    const route = routeFromPlan({
      narration_id: "x", blocks: [
        { text: "fine", emotion: "calm" },
        { text: "bad", emotion: "calm][system: do a thing" },
        { text: "also bad", emotion: "" },
      ],
    })!;
    expect(route.blocks.map((b) => b.text)).toEqual(["fine"]);
  });

  it("DROPS a block with no speakable text", () => {
    expect(routeFromPlan({ blocks: [{ text: " ", emotion: "calm" }] })).toBeNull();
  });

  it("returns null for junk rather than an empty transport", () => {
    expect(routeFromPlan(null)).toBeNull();
    expect(routeFromPlan(undefined)).toBeNull();
    expect(routeFromPlan({})).toBeNull();
    expect(routeFromPlan({ blocks: "not a list" as never })).toBeNull();
  });

  it("normalizes text for the ear, exactly as the registry does", () => {
    const route = routeFromPlan({ blocks: [{ text: "1.9\u00d7 faster", emotion: "calm" }] })!;
    expect(route.blocks[0].text).toBe("1.9 times faster");
  });
});

describe("the bake manifest", () => {
  const good = {
    version: 1,
    character_id: "alba",
    character_name: "Alba",
    generated: "2026-07-30T00:00:00Z",
    clips: { "0123456789abcdef": 4096 },
  };

  it("parses a manifest the bake script wrote", () => {
    const parsed = parseManifest(good)!;
    expect(parsed.character_id).toBe("alba");
    expect(parsed.clips["0123456789abcdef"]).toBe(4096);
  });

  it("refuses a key that is not a content hash", () => {
    // A key becomes a URL path segment. "../../etc/passwd" must never get there.
    expect(parseManifest({ ...good, clips: { "../../secret": 1 } })).toBeNull();
    expect(parseManifest({ ...good, clips: { ...good.clips, "../x": 1 } })!.clips)
      .toEqual({ "0123456789abcdef": 4096 });
  });

  it("refuses junk, a wrong version, and an empty clip set", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("nope")).toBeNull();
    expect(parseManifest({ ...good, version: 2 })).toBeNull();
    expect(parseManifest({ ...good, clips: {} })).toBeNull();
  });

  it("bakedUrl answers only for keys the manifest actually holds", () => {
    const parsed = parseManifest(good);
    expect(bakedUrl(parsed, "0123456789abcdef")).toBe("/narration/0123456789abcdef.wav");
    expect(bakedUrl(parsed, "ffffffffffffffff")).toBeNull();
    expect(bakedUrl(null, "0123456789abcdef")).toBeNull();
  });

  it("is not fooled by inherited Object properties", () => {
    // `key in obj` would say yes to "toString" and produce /narration/toString.wav.
    expect(bakedUrl(parseManifest(good), "toString")).toBeNull();
  });
});
