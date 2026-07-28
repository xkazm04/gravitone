// Playground model. A take is spoken by ONE Character; metatags switch its
// emotion Voices mid-sentence. A missing emotion is substituted with the
// nearest recorded one, and only then baseline (service/emotions.py::resolve).

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
};

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
