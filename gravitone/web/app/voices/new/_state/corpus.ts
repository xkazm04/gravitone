// THE VOICE CORPUS, as the studio sees it.
//
// The sovereignty loop the service already implements end to end: a recording
// the user OPTS IN to keep is stored on this box with its labels, its measured
// fidelity and the consent receipt it was kept under — inspectable, deletable
// one recording at a time, and re-derivable into better voices later without a
// second upload or a second cloud call.
//
// This module is the one place the wire contract lives (service/ingest.py::
// corpus_view / delete_clip / capture_corpus, service/ingest_api.py's three
// routes), plus the pure copy decisions that hang off it. It sits beside the
// ingest state machine because the JOB carries the capture outcome; the
// character page's corpus panel imports from here rather than re-declaring the
// same shapes a second time.
//
// One rule runs through all of it, and it is the service's own: a corpus fact
// is never inferred. "Nothing is kept" is a 200 with zero clips, "not
// requested" is a stated reason, and a deletion is a REPORT — the browser
// invents none of the three.

import { apiJson, throwDetail } from "@/lib/apiFetch";
import type { CorpusOutcome } from "./machine";

/** Per-clip fidelity, the compact half of the pipeline's payload. */
export type CorpusFidelity = {
  version?: number | null;
  reference_similarity?: number | null;
  cohesion_mad?: number | null;
  segments_measured?: number | null;
  /** {emotion: measured speaker identity of that stem}. Absent = not measured. */
  stem_identity?: Record<string, number> | null;
  /** The service's own sentence about WHAT was measured. Quoted, never rewritten. */
  measures?: string | null;
};

/** The consent receipt one recording is kept under. */
export type CorpusConsent = {
  consented_at?: string | null;
  statement?: string | null;
  clip_sha256?: string | null;
};

/** One kept recording. `clip_sha256` is its identity AND its delete address. */
export type CorpusClip = {
  clip_sha256: string;
  added?: string | null;
  mode?: string | null;
  bytes?: number | null;
  /** Seconds of audio actually ON DISK (labels without audio are not counted). */
  seconds: number;
  segments: number;
  segments_recorded: number;
  emotions: Record<string, { segments: number; seconds: number }>;
  fidelity?: CorpusFidelity | null;
  /** Voice ids cloned from this recording. They are NOT deleted with it. */
  voices: string[];
  consent: CorpusConsent;
  stems: { emotion: string; seconds?: number | null; segments?: number | null;
           identity?: number | null }[];
};

export type CorpusView = {
  character_id: string;
  corpus_rev?: number;
  updated?: string | null;
  clips: CorpusClip[];
  totals: { clips: number; segments: number; seconds: number; bytes: number };
  cap_bytes?: number;
  /** The service's own verdict — a rebuild is refused (409) while it is true. */
  over_cap?: boolean;
};

/** What a DELETE answered with. `removed: null` never reaches a client (it is
 *  the service's 404), so the report a caller holds always names what went. */
export type DeletionReport = {
  removed: {
    clip_sha256: string;
    segments: number;
    segment_labels: number;
    stems: number;
    seconds: number;
    bytes?: number | null;
    added?: string | null;
    /** False = the index forgot it but files survived on disk. Say so. */
    files_deleted: boolean;
  } | null;
  /** Non-null ONLY when something is still wrong after the deletion. */
  reason?: string | null;
  corpus_rev?: number;
  remaining: { clips: number; bytes: number };
};

/** POST /api/ingest/rederive — a pollable job, plus what it selected. */
export type RederiveStart = {
  job_id: string;
  mode: string;
  /** The service's report of what it picked, per emotion. Shape is its own. */
  selection?: unknown;
  corpus_rev?: number;
};

// ── reads & writes ────────────────────────────────────────────────────────────

/** What this box keeps for a character. An empty corpus is a SUCCESS (zero
 *  clips), never an error — see the route comment for why the service refuses
 *  to 404 it. */
export function loadCorpus(characterId: string, signal?: AbortSignal): Promise<CorpusView> {
  return apiJson<CorpusView>(
    `/api/characters/${encodeURIComponent(characterId)}/corpus`,
    { cache: "no-store", signal },
    "the kept recordings for this character could not be read",
  );
}

/** Remove one recording and return the service's report of what went. */
export async function deleteCorpusClip(
  characterId: string, clipSha: string,
): Promise<DeletionReport> {
  const r = await fetch(
    `/api/characters/${encodeURIComponent(characterId)}/corpus/${encodeURIComponent(clipSha)}`,
    { method: "DELETE" },
  );
  if (!r.ok) return throwDetail(r, "this recording could not be deleted");
  return (await r.json()) as DeletionReport;
}

/** Start a rebuild from the kept audio. The refusals (404 no corpus, 409 over
 *  cap / nothing matched, 429 queue full) arrive HERE with their own sentence. */
export async function startRederive(
  characterId: string, emotions?: string[],
): Promise<RederiveStart> {
  const r = await fetch("/api/ingest/rederive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ character_id: characterId,
                           ...(emotions?.length ? { emotions } : {}) }),
  });
  if (!r.ok) return throwDetail(r, "the rebuild could not be started");
  return (await r.json()) as RederiveStart;
}

// ── pure copy decisions ───────────────────────────────────────────────────────

/** Bytes as a person reads them. Kept here so the studio and the character
 *  panel print one recording's size the same way. */
export function formatBytes(n?: number | null): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * What the complete screen says about retention, and how loudly.
 *
 *   kept    — the audio IS on this box now; the sentence itemizes it.
 *   quiet   — nothing was kept and nothing was asked for. Stated once, softly:
 *             "we kept nothing" is worth saying on a page about someone's
 *             voice, but it is not a caveat and must not be dressed as one.
 *   warning — the user ASKED to keep it and it did not happen. The service's
 *             own reason is quoted; this is the only amber case, because it is
 *             the only one where the outcome differs from the request.
 *
 * Returns null when the service said nothing at all (an older backend) — an
 * absent key is not a claim in either direction, so the screen stays silent.
 */
export type CorpusNotice = { tone: "kept" | "quiet" | "warning"; text: string };

export function corpusNotice(c?: CorpusOutcome | null): CorpusNotice | null {
  if (!c || typeof c.requested !== "boolean") return null;
  if (c.captured) {
    const bits = [
      typeof c.segments === "number" ? `${c.segments} segment${c.segments === 1 ? "" : "s"}` : null,
      typeof c.stems === "number" ? `${c.stems} stem${c.stems === 1 ? "" : "s"}` : null,
      typeof c.bytes === "number" ? formatBytes(c.bytes) : null,
    ].filter(Boolean).join(" · ");
    return {
      tone: "kept",
      text: `This recording is kept on this box for the character${bits ? ` — ${bits}` : ""}.`
        + " You can inspect or delete it from the character page at any time.",
    };
  }
  // Already there is not a failure: the corpus is content-addressed, so a
  // re-ingest of the same file finding itself already stored is the system
  // working. Say it plainly rather than in amber.
  if (c.already) {
    return { tone: "kept",
      text: c.reason ?? "this recording is already kept for this character" };
  }
  if (!c.requested) {
    return { tone: "quiet",
      text: "Nothing of this recording was kept on this box." };
  }
  return {
    tone: "warning",
    text: `You asked to keep this recording, and it was not kept — ${
      c.reason ?? "the backend did not say why"}. The voices themselves were created.`,
  };
}
