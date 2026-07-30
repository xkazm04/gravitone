// ── Audible Docs: the narratable registry ────────────────────────────────────
//
// What the site says out loud, per route. Every word here is DERIVED from the
// same structured sources the pages render from (`lib/content.ts`,
// `lib/benchmarks.ts`) — never scraped out of the DOM. That is the whole point:
// the narration cannot drift from the page, because if the copy changes the
// registry changes with it, and the content hash changes with THAT, which
// invalidates exactly the cached audio that is now wrong.
//
// Rules this module holds:
//  • pure data + pure functions. No React, no fetch, no browser API — so it is
//    trivially testable and can be imported from anywhere.
//  • `text` is what the narrator ACTUALLY speaks (already normalized for the
//    ear: "1.9×" is unspeakable, "1.9 times" is not).
//  • connective tissue is structural only (". " between a title and its body).
//    No claim appears here that is not already in the source modules.
//  • `anchor` is a best-effort CSS selector for the scroll-follow highlight. A
//    selector that no longer resolves costs the highlight and nothing else —
//    playback never depends on the DOM.

import {
  API_DOCS_URL, FEATURES, HERO, STATS, SWITCH, VOICES,
} from "./content";
import { BENCHMARKS, HARNESS, boxCapacityAudPerS, costPerAudioHour } from "./benchmarks";

/** What KIND of thing this block is. Drives the narrator's emotion + tone. */
export type NarratableRole =
  | "hero"
  | "stat"
  | "voice"
  | "feature"
  | "switch"
  | "cta"
  | "benchmark"
  | "methodology";

/** Which sort of narrator this role wants when the listener has not picked one.
 *  Matched against a Character's tags/name — a hint, never a requirement. */
export type CharacterHint = "warm" | "measured";

export type NarratableBlock = {
  /** Stable within a route; part of no URL, so it may be renamed freely. */
  id: string;
  role: NarratableRole;
  /** Short human name — what the dock's block list shows. */
  label: string;
  /** The spoken text, already ear-normalized. */
  text: string;
  characterHint: CharacterHint;
  /** Emotion metatag applied to every sentence of this block. Must be a name
   *  from the service's scale (service/emotions.py::EMOTION_SCALE); an emotion
   *  a Character lacks falls back on the nearest, reported in the headers. */
  emotionTag: string;
  /** CSS selector for the on-page element to highlight. Best-effort. */
  anchor?: string;
  hash: string;
  dbgSrc?: string;
};

export type NarratableRoute = {
  route: string;
  /** Spoken name of the whole reading — the dock's title. */
  title: string;
  blocks: NarratableBlock[];
};

// ── hashing ──────────────────────────────────────────────────────────────────

/**
 * FNV-1a, 64 bits, as 16 hex chars. Deliberately NOT crypto.subtle: that is
 * async and absent in several of the environments this module is imported from
 * (node test runs, SSR), and a cache key does not need to resist an adversary —
 * it needs to be identical in every environment, forever, for the same string.
 */
export function contentHash(input: string): string {
  // Two 32-bit lanes, because JS bitwise ops are 32-bit. Lane B is seeded
  // differently so the halves cannot collide together on short inputs.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    a ^= c;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= c + i;
    b = Math.imul(b, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * Hash several fields as ONE key, joined by an explicit separator.
 *
 * The separator is the ASCII unit separator (char 31) rather than a space
 * on purpose: a space can appear inside a field, so `["a b", "c"]` and
 * `["a", "b c"]` would hash identically, and a cache key that can collide
 * across fields is a cache that can play the wrong voice. Every hash in this
 * module goes through here so the shape is stated once.
 */
/** ASCII unit separator, built from its code point so no invisible control
 *  character ever sits in this file. (One did, once: an unprintable byte in a
 *  hash template made two identical-looking strings hash differently.) */
const SEPARATOR = String.fromCharCode(31);

export function hashParts(...parts: string[]): string {
  return contentHash(parts.join(SEPARATOR));
}

// ── ear normalization ────────────────────────────────────────────────────────

/** Symbols that read fine on screen and terribly out loud.
 *
 *  Each pattern eats the whitespace AROUND the symbol as well as the symbol
 *  itself. Replacing "·" with ", " alone left "warm , en" — the comma detached
 *  from the word it belongs to, which a TTS engine renders as an audible stumble
 *  rather than a clause break. */
const SPOKEN: [RegExp, string][] = [
  [/\s*×\s*/g, " times "],
  [/\s*·\s*/g, ", "],
  [/\s*→\s*/g, " then "],
  [/\s*∞\s*/g, " unlimited "],
  [/\s*—\s*/g, " — "],
  [/\baud\/s\b/g, "audio-seconds per second"],
  [/\bRTF\b/g, "realtime factor"],
];

/** Normalize a source string into something a TTS engine can say. */
export function speakable(text: string): string {
  let out = text;
  for (const [re, to] of SPOKEN) out = out.replace(re, to);
  // Whitespace collapse LAST: the replacements above deliberately pad, and a
  // source string can carry newlines from a template literal.
  return out.replace(/[^\S\n]*\n[^\S\n]*/g, " ").replace(/[ \t]+/g, " ").trim();
}

/**
 * Split a block into the units that are actually synthesized.
 *
 * One request per sentence is what makes the dock feel alive (first audio in
 * about a second instead of after the whole paragraph) AND what makes the cache
 * granular — an edit to the last sentence of a feature does not re-synthesize
 * the first. Over-long sentences are split at their last comma so no single
 * request can tie up a synth slot for a minute.
 */
export function splitSentences(text: string, maxChars = 260): string[] {
  const rough = speakable(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const piece of rough) {
    let rest = piece;
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(", ", maxChars);
      if (cut <= 40) break; // no sane split point — send it whole
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 2).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** Wrap one sentence in this block's emotion metatag (service parses these). */
export function taggedSentence(block: NarratableBlock, sentence: string): string {
  return `[${block.emotionTag}]${sentence}[/${block.emotionTag}]`;
}

/**
 * The cache key for one synthesized sentence: content-addressed over everything
 * that changes the audio. A different narrator, a different emotion or a single
 * edited word is a different key — so a cache hit is always the right audio.
 */
export function clipKey(characterId: string, block: NarratableBlock, sentence: string): string {
  return hashParts(characterId, block.emotionTag, sentence);
}

// ── role defaults ────────────────────────────────────────────────────────────

const ROLE: Record<NarratableRole, { emotion: string; hint: CharacterHint }> = {
  hero: { emotion: "excited", hint: "warm" },
  stat: { emotion: "happy", hint: "warm" },
  voice: { emotion: "happy", hint: "warm" },
  feature: { emotion: "baseline", hint: "measured" },
  switch: { emotion: "baseline", hint: "measured" },
  cta: { emotion: "excited", hint: "warm" },
  benchmark: { emotion: "calm", hint: "measured" },
  methodology: { emotion: "calm", hint: "measured" },
};

function block(
  id: string,
  role: NarratableRole,
  label: string,
  parts: (string | null | undefined)[],
  anchor?: string,
): NarratableBlock {
  const text = speakable(parts.filter(Boolean).join(" "));
  const { emotion, hint } = ROLE[role];
  return {
    id,
    role,
    label,
    text,
    characterHint: hint,
    emotionTag: emotion,
    anchor,
    hash: hashParts(role, emotion, text),
  };
}

/** A sentence-terminated fragment, so joined parts do not run together. */
function stop(s: string): string {
  return /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;
}

// ── the landing page ─────────────────────────────────────────────────────────

function landing(): NarratableRoute {
  const blocks: NarratableBlock[] = [
    block(
      "hero",
      "hero",
      "Opening",
      [stop(HERO.eyebrow), stop(`${HERO.headlinePlain} ${HERO.headlineAccent}`), HERO.sub],
      "nav + section",
    ),
    block(
      "stats",
      "stat",
      "The numbers",
      STATS.map((s) => stop(`${s.value} ${s.label}`)),
      "nav + section",
    ),
    block(
      "voices",
      "voice",
      "Voices",
      VOICES.map((v) => stop(`${v.name}, ${v.tag}`)),
      "#voices",
    ),
    ...FEATURES.map((f, i) =>
      block(`feature-${f.key}`, "feature", f.title, [stop(f.title), f.body],
            `#api > :nth-child(${i + 1})`),
    ),
    block(
      "switch",
      "switch",
      "Switch kit",
      [stop(SWITCH.eyebrow), stop(SWITCH.headline), SWITCH.sub, stop(SWITCH.note)],
      "#switch",
    ),
    block(
      "close",
      "cta",
      "Where to go next",
      [
        stop(HERO.primaryCta),
        // The URL itself is never spoken — a read-aloud github link is noise.
        // What it IS gets said, and the link stays on screen.
        API_DOCS_URL ? stop(HERO.secondaryCta) : null,
      ],
      "#playground",
    ),
  ];
  return { route: "/", title: "Gravitone — the landing page, read aloud", blocks };
}

// ── /benchmarks ──────────────────────────────────────────────────────────────

/** One measured row, spoken as the claim it is. Every number comes from the
 *  dataset or from the same helpers the page's own table calls, so the narrator
 *  cannot quote a figure the page does not show. */
function benchmarkRow(b: (typeof BENCHMARKS)[number]): NarratableBlock {
  const cost = costPerAudioHour(b);
  const where = b.instance ? `${b.platform}, ${b.instance}` : b.platform;
  return block(
    `bench-${b.id}`,
    "benchmark",
    where,
    [
      stop(`${where}, ${b.cpu}, ${b.vcpu} vCPU`),
      stop(`${b.singleStreamRtf} times realtime on a single stream`),
      b.multiProcessAudPerS != null && b.processes != null
        ? stop(`${boxCapacityAudPerS(b)} audio-seconds per second across ${b.processes} processes`)
        : null,
      cost != null ? stop(`that is $${cost.toFixed(4)} per audio-hour`) : null,
      stop(b.notes),
    ],
    // The leaderboard is the first <section> on the page; the rows inside it are
    // not individually addressable, so every row highlights the board.
    "section:nth-of-type(1)",
  );
}

function benchmarks(): NarratableRoute {
  const blocks: NarratableBlock[] = [
    block(
      "bench-intro",
      "hero",
      "Receipts included",
      [stop(`Measured ${HARNESS.measured}`), stop(HARNESS.reproduce)],
      "header",
    ),
    ...BENCHMARKS.map(benchmarkRow),
    block(
      "bench-method",
      "methodology",
      "Methodology",
      [stop(`Harness: ${HARNESS.method}`), stop(`Runtime: ${HARNESS.torch}`)],
      "section:nth-of-type(3)",
    ),
  ];
  return { route: "/benchmarks", title: "Benchmarks — the receipts, read aloud", blocks };
}

// ── the registry ─────────────────────────────────────────────────────────────

/** Built once at module load: the blocks are pure functions of frozen data, so
 *  a hash computed here is the same hash any other environment computes. */
export const NARRATABLE: Record<string, NarratableRoute> = {
  "/": landing(),
  "/benchmarks": benchmarks(),
};

/** The reading for a pathname, or null when this route says nothing.
 *  A route with no entry must render NO dock at all — an empty transport on a
 *  page that cannot be narrated is a promise the product does not keep. */
export function narratableFor(pathname: string | null | undefined): NarratableRoute | null {
  if (!pathname) return null;
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return NARRATABLE[clean || "/"] ?? null;
}

// ── arbitrary narrations (the POST /v1/narrate consumer) ─────────────────────
//
// Everything above describes THIS site, derived from its own content modules.
// The service's `/v1/narrate` produces the same shape for any page — a customer's
// docs, a blog post, a pasted README — and the dock plays both through one code
// path. The conversion below is the only seam between them, and it is
// deliberately suspicious of what it is given: a plan arrives over the network,
// so a block missing `text`, or carrying an emotion that is not a name, is
// DROPPED rather than pushed into a synthesis request.

/** One block as `/v1/narrate` emits it (service/narrate.py::build_blocks). */
export type NarrationPlanBlock = {
  id?: string;
  label?: string;
  text?: string;
  emotion?: string;
  character_hint?: string;
  hash?: string;
  role?: string;
};

export type NarrationPlanDoc = {
  narration_id?: string;
  title?: string;
  blocks?: NarrationPlanBlock[];
};

/** Emotion names the service's scale can carry (service/emotions.py). Anything
 *  else is refused here rather than at synthesis time, where it would cost a
 *  round trip to learn. */
const EMOTION_NAME = /^[a-z][a-z0-9_]{1,23}$/;

/**
 * A remote narration plan, as the route the dock already knows how to play.
 *
 * Returns null when the plan carries nothing playable — which the dock reports
 * as a named refusal, because "the service answered with an empty reading" and
 * "the request failed" are different sentences.
 */
export function routeFromPlan(plan: NarrationPlanDoc | null | undefined): NarratableRoute | null {
  const raw = Array.isArray(plan?.blocks) ? plan.blocks : [];
  const blocks: NarratableBlock[] = [];
  raw.forEach((b, i) => {
    const text = speakable(String(b?.text ?? ""));
    const emotion = String(b?.emotion ?? "").trim();
    if (text.length < 2 || !EMOTION_NAME.test(emotion)) return;
    const role: NarratableRole = b?.role === "lead" ? "hero" : "feature";
    blocks.push({
      id: String(b?.id ?? `b${i}`).slice(0, 32),
      role,
      label: String(b?.label ?? text).slice(0, 90),
      text,
      // The service's hint vocabulary is this module's vocabulary; anything
      // unrecognised reads measured, which is the safer default for prose.
      characterHint: b?.character_hint === "warm" ? "warm" : "measured",
      emotionTag: emotion,
      // No anchor: the blocks describe a document this page is not rendering,
      // so there is nothing on screen to highlight. The dock's highlight code
      // already treats a missing anchor as "no highlight".
      hash: b?.hash ? String(b.hash).slice(0, 32) : hashParts(emotion, text),
    });
  });
  if (!blocks.length) return null;
  return {
    route: `narration:${String(plan?.narration_id ?? "").slice(0, 32)}`,
    title: String(plan?.title ?? "").slice(0, 120) || "A narration, read aloud",
    blocks,
  };
}

// ── build-time baked audio ───────────────────────────────────────────────────
//
// `npm run bake:narration` renders the registry once and writes the clips under
// public/narration/. A baked clip is the SAME bytes the dock would have
// synthesized — same key, same emotion tag, same narrator — so preferring it is
// invisible except in the status line and in the engine time it does not spend.
//
// The manifest exists so the dock can know what was baked WITHOUT a request per
// sentence: a 404 for a clip that was never baked is indistinguishable from a
// deployment problem, and forty of them per page would be indistinguishable
// from an outage.

export const BAKED_PREFIX = "/narration";
export const BAKED_MANIFEST = `${BAKED_PREFIX}/manifest.json`;

export type BakeManifest = {
  version: 1;
  /** Which narrator the clips were baked with. A listener who picks anyone
   *  else gets live synthesis, because the keys will not match — which is the
   *  correct outcome, not a bug: the bake is one voice's reading. */
  character_id: string;
  character_name: string;
  generated: string;
  /** clipKey → the file's byte length, for the manifest to be worth reading. */
  clips: Record<string, number>;
};

/** The static file for one clip key, or null when it was not baked. */
export function bakedUrl(manifest: BakeManifest | null, key: string): string | null {
  if (!manifest || !Object.prototype.hasOwnProperty.call(manifest.clips, key)) return null;
  return `${BAKED_PREFIX}/${key}.wav`;
}

/** Parse a fetched manifest, or null. Never throws: a malformed manifest must
 *  cost the bake and nothing else. */
export function parseManifest(raw: unknown): BakeManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.version !== 1 || typeof m.character_id !== "string") return null;
  const clips = m.clips;
  if (!clips || typeof clips !== "object") return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(clips as Record<string, unknown>)) {
    // Keys are content hashes this module produced; anything else is not a key
    // we can ever look up, and letting it through would put an attacker-chosen
    // string into a URL.
    if (/^[0-9a-f]{16}$/.test(key) && typeof value === "number") out[key] = value;
  }
  if (!Object.keys(out).length) return null;
  return {
    version: 1,
    character_id: m.character_id,
    character_name: typeof m.character_name === "string" ? m.character_name : m.character_id,
    generated: typeof m.generated === "string" ? m.generated : "",
    clips: out,
  };
}

/** One flattened playback unit: which block it belongs to, and what to say. */
export type NarrationStep = {
  blockIndex: number;
  block: NarratableBlock;
  /** Index of this sentence WITHIN its block — for "sentence 2 of 5" copy. */
  sentenceIndex: number;
  sentence: string;
};

/** The whole route, flattened into the sentences the dock plays in order. */
export function narrationPlan(route: NarratableRoute): NarrationStep[] {
  const steps: NarrationStep[] = [];
  route.blocks.forEach((b, blockIndex) => {
    splitSentences(b.text).forEach((sentence, sentenceIndex) => {
      steps.push({ blockIndex, block: b, sentenceIndex, sentence });
    });
  });
  return steps;
}
