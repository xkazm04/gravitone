// Playground model. A take is spoken by ONE Character; metatags switch its
// emotion Voices mid-sentence. A missing emotion is substituted with the
// nearest recorded one, and only then baseline (service/emotions.py::resolve).

import { hueFor } from "@/lib/glyphs/generate";
import type { OutputFormat } from "@/lib/audioFormats";

export type Segment = {
  text: string;
  requested: string;
  used: string;
  fallback: boolean;
  voice_id: string;
  seconds: number;
  // Performance takes only: which Character spoke this segment and its source
  // line index in the script (absent for solo takes — one Character throughout).
  characterId?: string;
  line?: number;
};

/**
 * The tint a Character is drawn in.
 *
 * A scene is only readable as a scene if each speaker keeps ONE colour across
 * every surface that shows it, so the hue is a pure function of the Character's
 * id — the same rule `emotionMeta` uses for custom emotions, and the same hash,
 * so two Characters are as unlikely to collide as two custom slots are. (The
 * console's line dot still derives its own hue from the id's LENGTH, which
 * collides for every pair of equal-length ids; it can adopt this without any
 * data change.)
 */
export function characterHue(characterId: string): number {
  return hueFor(characterId);
}

/** One directed line of a multi-character performance script. */
export type PerfLine = { character_id: string; text: string };

/** One line in the Script composer (stable id for React keys + reordering).
 *  Lives here rather than in the console because it is persisted — see
 *  lib/composerStore. */
export type ScriptLine = { id: string; characterId: string; text: string };

export type Take = {
  id: string;
  text: string;
  characterId: string;
  characterName: string;
  mode: "gravitone" | "browser";
  // Why the browser voice was used (browser takes only) — "unreachable",
  // "draining" or "failed". Optional: takes restored from before this field
  // existed have none.
  fallbackReason?: "unreachable" | "draining" | "failed";
  // What the backend actually said about the failure (its sanitized `detail`,
  // which carries the request-correlation id). Browser takes only, and only
  // when the engine answered at all.
  fallbackDetail?: string;
  url?: string;
  // The take's audio, kept alongside its object URL so publishing/persisting it
  // never has to fetch the URL back into a second copy of the same bytes.
  // Absent for browser-fallback takes (nothing was synthesized).
  blob?: Blob;
  peaks: number[];
  seconds: number;
  kb: number;
  rtf: number;
  // Honest timing (server-side synthesis time + queue wait, seconds) and any
  // accepted-but-inert voice settings the backend reported ignoring.
  synthSeconds: number;
  queueSeconds: number;
  ignoredSettings: string[];
  segments: Segment[];
  // The engine sent a per-segment report this build could not decode, so
  // `segments` is empty for a reason that is not "one segment". Optional:
  // absent on every take stored before the distinction existed, where it reads
  // as false — which is what those takes recorded.
  reportCorrupt?: boolean;
  // The expression knobs this take was rendered with — together with text +
  // characterId this is the exact reproduction recipe for the code export.
  expr: Expression;
  // Epoch ms the take was rendered — the sort key for session restore.
  createdAt: number;
  // The output format this take was rendered as (lib/audioFormats). Optional:
  // takes restored from before the choice existed have none, and read as wav —
  // which is exactly what they are.
  format?: OutputFormat;
  // Performance takes only: the directed script that produced this take. Drives
  // the /v1/performance code export and survives session restore. Absent (undefined)
  // for solo takes.
  lines?: PerfLine[];
  // Which generation of the TIMING numbers above (rtf / synthSeconds /
  // queueSeconds) this take carries — see TAKE_TIMING_VERSION. Absent on every
  // take written before the marker existed.
  timingVersion?: number;
  // Punch-in provenance: this take is a SPLICE of an earlier one. Absent for
  // every take that was rendered in one call (and for every take stored before
  // the editor existed) — see TakeEdits.
  edits?: TakeEdits;
};

// ── punch-in provenance (D5) ────────────────────────────────────────────────
/**
 * How a spliced take was made.
 *
 * `source` is the id of the ORIGINAL take (the base render), and `regions` is
 * every patch applied since, in order — so one take carries its whole
 * reproduction recipe: the base `/v1/performance` (or `/v1/speak`) call plus one
 * `/v1/speak` call per patched region. A chain of ids would have been smaller
 * and would have left the code export unable to print the recipe once the
 * intermediate takes aged out of the log.
 *
 * `v` is why older stored takes restore cleanly: takes are durable
 * (lib/takeStore, IndexedDB), so the console reads records written by builds
 * that had no editor at all. `readEdits` treats an absent OR unrecognised
 * version as "no edit history", which is exactly what such a record has — and
 * never as a reason to refuse the take.
 */
export const TAKE_EDITS_VERSION = 1;

/** One punched region: which segment index, the text that was re-rendered, and
 *  the per-region overrides it was rendered with. */
export type EditRegion = {
  i: number;
  text: string;
  emotion?: string;
  characterId?: string;
};

export type TakeEdits = {
  v: 1;
  /** Take id of the base render this chain started from. */
  source: string;
  regions: EditRegion[];
};

/** Read a take's edit history defensively. Returns null for a take with none,
 *  for a record written before the field existed, and for a version this build
 *  does not understand — all three mean "there is no history to show", and none
 *  of them is a reason to lose the take. */
export function readEdits(t: { edits?: unknown } | null | undefined): TakeEdits | null {
  const e = t?.edits as Partial<TakeEdits> | undefined;
  if (!e || e.v !== TAKE_EDITS_VERSION || typeof e.source !== "string") return null;
  const regions = Array.isArray(e.regions) ? e.regions : [];
  const clean = regions.filter(
    (r): r is EditRegion =>
      !!r && typeof r === "object" && Number.isInteger((r as EditRegion).i) && typeof (r as EditRegion).text === "string",
  );
  return { v: TAKE_EDITS_VERSION, source: e.source, regions: clean };
}

/** The edit history a spliced take inherits from `base` plus one new region.
 *  The chain's `source` stays the ORIGINAL render, so a take punched five times
 *  still names the call that made it. */
export function appendEdit(base: Take, region: EditRegion): TakeEdits {
  const prior = readEdits(base);
  return {
    v: TAKE_EDITS_VERSION,
    source: prior?.source ?? base.id,
    regions: [...(prior?.regions ?? []), region],
  };
}

// ── timeline math ───────────────────────────────────────────────────────────
/** One clickable region of a take: a segment, placed in time. */
export type Region = {
  index: number;
  start: number;
  end: number;
  segment: Segment;
};

/**
 * Place a take's segments on its timeline.
 *
 * The offsets come from the cumulative `segment.seconds` the backend reported,
 * SCALED so the last region ends exactly at the take's real (decoded) duration.
 * The report and the samples disagree by a few milliseconds per segment — the
 * engine trims and concatenates — and without the scale that error accumulates
 * until a click near the end of a 40-line performance seeks past the audio.
 *
 * A report with no usable seconds (all zero, or absent) still gets regions: the
 * duration is divided equally, which is a labelled guess at WHERE each segment
 * is, not a claim about how long it took to say.
 */
export function segmentRegions(segments: Segment[], duration: number): Region[] {
  if (segments.length === 0 || !(duration > 0)) return [];
  const secs = segments.map((s) => (Number.isFinite(s.seconds) && s.seconds > 0 ? s.seconds : 0));
  const sum = secs.reduce((a, b) => a + b, 0);
  const even = duration / segments.length;
  let at = 0;
  return segments.map((segment, index) => {
    const len = sum > 0 ? (secs[index] / sum) * duration : even;
    const start = at;
    at = index === segments.length - 1 ? duration : Math.min(duration, at + len);
    return { index, start, end: at, segment };
  });
}

/** Re-scale a fragment's reported segment seconds onto its decoded duration —
 *  the same "samples are the truth" rule as segmentRegions, applied to the
 *  segments a spliced take carries so the NEXT timeline is built from honest
 *  numbers. */
export function scaleSegmentSeconds(segments: Segment[], duration: number): Segment[] {
  const sum = segments.reduce((n, s) => n + (s.seconds > 0 ? s.seconds : 0), 0);
  if (segments.length === 0) return [];
  if (!(duration > 0)) return segments;
  if (sum <= 0) {
    const even = Math.round((duration / segments.length) * 100) / 100;
    return segments.map((s) => ({ ...s, seconds: even }));
  }
  return segments.map((s) => ({
    ...s,
    seconds: Math.round(((s.seconds > 0 ? s.seconds : 0) / sum) * duration * 100) / 100,
  }));
}

/**
 * Version of a take's TIMING numbers.
 *
 * Takes are durable (lib/takeStore, IndexedDB), so the console restores records
 * written by older builds — and it uses the newest take's `rtf` to calibrate the
 * render estimate. When the MEANING of `rtf` changes, an old record silently
 * calibrates today's estimate with yesterday's arithmetic: the pre-fix value was
 * a sum of the per-segment factors, which overstates throughput and therefore
 * understates the wait the user is about to sit through.
 *
 * 1 — `rtf` is the wall-clock realtime factor of the whole call
 *     (X-Realtime-Factor). Records with NO marker predate that fix and are not
 *     used as an estimate basis; they still play, download, share and export
 *     exactly as before, and their numbers are still displayed as what that run
 *     reported. Bump this whenever the timing arithmetic changes again.
 */
export const TAKE_TIMING_VERSION = 1;

/** Whether a take's timing may be used to calibrate the render estimate.
 *  A take from an older build is not wrong to show — it is only wrong to
 *  predict with. */
export function isTimingBasis(t: Pick<Take, "mode" | "rtf" | "timingVersion">): boolean {
  return t.mode === "gravitone" && t.rtf > 0 && t.timingVersion === TAKE_TIMING_VERSION;
}

/** Expression controls. Pocket TTS has no emotion/speed parameter — these are
 *  the model's real sampling knobs (temp / noise_clamp / lsd_decode_steps). */
export type Expression = {
  temperature: number; // 0.5 consistent .. 1.0 expressive
  stability: number;   // 0 off .. 1 tight (noise_clamp)
  quality: number;     // 1 fast .. 5 best (costs realtime factor)
};

export const DEFAULT_EXPRESSION: Expression = { temperature: 0.7, stability: 0, quality: 1 };

/** Deterministic pseudo-waveform for browser-fallback takes. */
export function waveHeights(seed: number, n = 48): number[] {
  const out: number[] = [];
  let s = seed || 1;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const env = Math.sin((i / n) * Math.PI);
    out.push(0.18 + ((s % 100) / 100) * 0.82 * (0.5 + env * 0.5));
  }
  return out;
}

/** Remove metatags — used for the browser-speech fallback and char counts. */
export function stripTags(text: string): string {
  return text.replace(/\[\/?[a-zA-Z_]*\]/g, "").replace(/\s+/g, " ").trim();
}

// ── the score: emotion regions over character offsets ───────────────────────
//
// The engine addresses emotion with an INLINE grammar (service/emotions.py):
//
//     Hello there. [excited]This is amazing![/excited] And now, back to normal.
//
// which is a fine wire format and a terrible editing model — you cannot drag a
// substring, and every offset in it is off by the length of the tags around it.
// So the UI models a take as PLAIN TEXT plus a list of regions expressed over
// offsets INTO THAT PLAIN TEXT, and `toTags`/`parseTags` bridge the two.
//
// The string remains the API contract: nothing new is sent, nothing new is
// stored, and a take composed by typing tags by hand and a take directed on the
// score are the same request. These functions are pure so the round-trip is
// testable in both directions, which is the only thing standing between a
// visual editor and a corrupted prompt.
//
// `baseline` is the ABSENCE of a region, not a region whose value is
// "baseline" — that is what the grammar means by a closing tag, and keeping the
// two spellings from both existing is what makes the round-trip stable.

/** The scale's neutral. Mirrors service/emotions.py::BASELINE. */
export const SCORE_BASELINE = "baseline";

/**
 * The tag grammar, character for character as the service compiles it
 * (`_TAG_RE = re.compile(r"\[(/?)([a-zA-Z_]*)\]")`). Built fresh per call —
 * a shared /g regex carries `lastIndex` between calls.
 */
function tagRe(): RegExp {
  return /\[(\/?)([a-zA-Z_]*)\]/g;
}

/**
 * Which emotion names the grammar can actually carry.
 *
 * NOTE the asymmetry, because it is a real one: `normalize_emotion` accepts
 * DIGITS in a custom emotion (`[a-z][a-z0-9_]{1,23}`) but the tag regex does
 * not, so an emotion named `mode2` is a legal slot that no inline tag can
 * address. A region for it therefore cannot be serialised — `regionProblem`
 * says so out loud rather than letting `toTags` drop it silently.
 */
const TAGGABLE = /^[a-zA-Z_]+$/;

/** One directed span of the text: characters [start, end) spoken as `value`. */
export type ScoreRegion = {
  start: number;
  end: number;
  kind: "emotion";
  value: string;
};

/** Build a region without repeating the discriminant at every call site. */
export function scoreRegion(start: number, end: number, value: string): ScoreRegion {
  return { start, end, kind: "emotion", value };
}

/**
 * Why this region cannot be placed on this text — or null when it can.
 *
 * The editor calls this BEFORE adding a region so a refusal is a sentence the
 * user reads, not a region that quietly fails to serialise. `others` is the
 * regions already on the text (overlaps are refused: the grammar has no nesting
 * — `[/x]` returns to baseline, not to the enclosing tag — so two overlapping
 * regions cannot both survive a round-trip).
 */
export function regionProblem(
  text: string,
  region: ScoreRegion,
  others: ScoreRegion[] = [],
): string | null {
  if (!Number.isInteger(region.start) || !Number.isInteger(region.end)) {
    return "That region has no whole-character bounds.";
  }
  if (region.start < 0 || region.end > text.length) {
    return "That region falls outside the text.";
  }
  if (region.end <= region.start) {
    return "Select at least one character to direct — an empty region says nothing.";
  }
  if (region.value === SCORE_BASELINE) {
    return "Baseline is the absence of direction — delete the region instead of tagging it baseline.";
  }
  if (!TAGGABLE.test(region.value)) {
    return `"${region.value}" cannot be written as an inline tag (letters and underscores only), so it cannot be sent to the engine.`;
  }
  const clash = others.find((o) => o !== region && o.start < region.end && region.start < o.end);
  if (clash) {
    return `That overlaps the ${clash.value} region — the tag grammar has no nesting, so regions cannot overlap.`;
  }
  return null;
}

/**
 * The regions that can actually be written, in order.
 *
 * Defensive rather than trusting: clamps to the text, drops empty/unwritable
 * ones and drops any region overlapping one already kept. `toTags` runs this so
 * a bad region can never corrupt the string that goes to the engine; the editor
 * runs `regionProblem` first so it never produces one.
 */
export function normalizeRegions(text: string, regions: ScoreRegion[]): ScoreRegion[] {
  const kept: ScoreRegion[] = [];
  const sorted = regions
    .filter((r) => !!r && Number.isInteger(r.start) && Number.isInteger(r.end))
    .map((r) => scoreRegion(Math.max(0, r.start), Math.min(text.length, r.end), r.value))
    .filter((r) => r.end > r.start && r.value !== SCORE_BASELINE && TAGGABLE.test(r.value))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const r of sorted) {
    const last = kept[kept.length - 1];
    if (last && r.start < last.end) continue; // overlap: first one wins
    kept.push(r);
  }
  return kept;
}

/** Serialise plain text + regions into the inline `[tag]` string the engine
 *  takes. Regions that cannot be written are dropped (see normalizeRegions). */
export function toTags(text: string, regions: ScoreRegion[]): string {
  let out = "";
  let at = 0;
  for (const r of normalizeRegions(text, regions)) {
    out += `${text.slice(at, r.start)}[${r.value}]${text.slice(r.start, r.end)}[/${r.value}]`;
    at = r.end;
  }
  return out + text.slice(at);
}

/**
 * Read an inline `[tag]` string back into plain text + regions.
 *
 * Follows the service's grammar exactly, including its two sharp edges:
 *   * `[/anything]` and `[]` both return to BASELINE — the grammar does not
 *     nest, so `[a]x[b]y[/b]z[/a]` ends with `z` at baseline, not at `a`.
 *   * an unclosed tag runs to the next tag or to the end of the text.
 * Baseline runs produce no region, and a run with no characters in it (`[a][b]`,
 * `[a][/a]`) produces none either — both are exactly what the engine renders.
 */
export function parseTags(tagged: string): { text: string; regions: ScoreRegion[] } {
  let text = "";
  let pos = 0;
  let current = SCORE_BASELINE;
  let openAt = 0;
  const regions: ScoreRegion[] = [];
  const close = (at: number) => {
    if (current !== SCORE_BASELINE && at > openAt) regions.push(scoreRegion(openAt, at, current));
  };
  for (const m of tagged.matchAll(tagRe())) {
    text += tagged.slice(pos, m.index);
    pos = m.index + m[0].length;
    close(text.length);
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    current = closing || !name ? SCORE_BASELINE : name;
    openAt = text.length;
  }
  text += tagged.slice(pos);
  close(text.length);
  return { text, regions };
}

/** What an edit did to the score: the regions that survived (shifted onto the
 *  new text) and the ones that were CLEARED because the words underneath them
 *  changed. Never a silent drift onto different words. */
export type ScoreShift = { regions: ScoreRegion[]; cleared: ScoreRegion[] };

/**
 * Carry regions across a text edit.
 *
 * Offsets are the fragile part of this model — the risk M2 names — so the rule
 * is stated once, here, and tested as a matrix:
 *
 *   * edit entirely BEFORE a region  → the region shifts by the length delta
 *   * edit entirely AFTER a region   → the region is untouched
 *   * pure INSERTION strictly inside → the region grows to include it. Nothing
 *     the region covered has changed, so this is the one interior edit that
 *     cannot land the direction on different words (typing a word into a
 *     whispered clause keeps it whispered — clearing there would be hostile).
 *   * anything else that touches the span (any deletion or replacement that
 *     overlaps it, an edit that swallows it whole) → the region is CLEARED and
 *     returned in `cleared` so the caller can NAME it in a notice.
 *
 * The edit is recovered as a single replaced run (common prefix + common
 * suffix), which is what a textarea edit is. It is deliberately conservative:
 * two far-apart changes arriving as one change read as one big replaced span
 * and clear everything between them, which is honest — it never guesses.
 */
export function transformRegions(regions: ScoreRegion[], before: string, after: string): ScoreShift {
  if (before === after) return { regions: [...regions], cleared: [] };

  let p = 0;
  const min = Math.min(before.length, after.length);
  while (p < min && before[p] === after[p]) p += 1;
  let s = 0;
  while (s < min - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s += 1;

  const removedEnd = before.length - s;
  const removedLen = removedEnd - p;
  const delta = after.length - before.length;

  const kept: ScoreRegion[] = [];
  const cleared: ScoreRegion[] = [];
  for (const r of regions) {
    if (r.end <= p) {
      kept.push(r);
    } else if (r.start >= removedEnd) {
      kept.push(scoreRegion(r.start + delta, r.end + delta, r.value));
    } else if (removedLen === 0 && r.start < p && p < r.end) {
      kept.push(scoreRegion(r.start, r.end + delta, r.value));
    } else {
      cleared.push(r);
    }
  }
  return { regions: normalizeRegions(after, kept), cleared };
}

// ── the limits the SERVER actually enforces ─────────────────────────────────
// Mirrored from service/app.py (SpeakRequest.text / PerformanceLine.text
// max_length=8000, PerformanceRequest.lines max_length=64) and
// web/lib/backend.ts (MAX_SYNTH_BODY_BYTES). The composer used to enforce none
// of them, so the ceiling was learned by having a render rejected.
export const MAX_TEXT_CHARS = 8000;
export const MAX_SCRIPT_LINES = 64;
export const MAX_BODY_BYTES = 128 * 1024;

export const DEFAULT_TEXT =
  "Hello there. [excited]This part is amazing![/excited] And now, back to normal.";

/**
 * Why this composer cannot be rendered — or null when it can.
 *
 * The composer enforced nothing, so every one of these limits was learned by
 * having a render rejected AFTER the wait. Each message names the number, the
 * ceiling and what to do about it; the caller shows it before submit and gates
 * Generate on it.
 *
 * The character caps count the RAW text (metatags included), because that is
 * what the backend receives and measures.
 */
export function composerLimit(input: {
  mode: "solo" | "script";
  text: string;
  script: Array<{ text: string }>;
}): string | null {
  const bytes = (v: string) => new TextEncoder().encode(v).length;
  if (input.mode === "solo") {
    const over = input.text.length - MAX_TEXT_CHARS;
    if (over > 0) {
      return `${input.text.length.toLocaleString()} characters — ${over.toLocaleString()} over the ${MAX_TEXT_CHARS.toLocaleString()}-character limit the engine accepts. Shorten it or split it into a script.`;
    }
    if (bytes(input.text) > MAX_BODY_BYTES) {
      return `This take is ${Math.round(bytes(input.text) / 1024)} KB — over the ${Math.round(MAX_BODY_BYTES / 1024)} KB the studio can forward in one request.`;
    }
    return null;
  }
  const longLine = input.script.findIndex((l) => l.text.length > MAX_TEXT_CHARS);
  if (longLine >= 0) {
    return `Line ${longLine + 1} is over the ${MAX_TEXT_CHARS.toLocaleString()}-character limit the engine accepts per line.`;
  }
  if (input.script.length > MAX_SCRIPT_LINES) {
    return `${input.script.length} lines — the engine renders at most ${MAX_SCRIPT_LINES} in one performance.`;
  }
  // Every line adds its own JSON envelope (ids, settings) on top of its text;
  // 64 bytes per line keeps the estimate on the safe side of the proxy's cap.
  const body = input.script.reduce((n, l) => n + bytes(l.text) + 64, 0);
  if (body > MAX_BODY_BYTES) {
    return `This script is ${Math.round(body / 1024)} KB — over the ${Math.round(MAX_BODY_BYTES / 1024)} KB the studio can forward in one request. Render it in parts.`;
  }
  return null;
}
