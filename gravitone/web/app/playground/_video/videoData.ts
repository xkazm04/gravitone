"use client";

// The video data layer: every surface that reads a job, submits work or polls
// goes through THESE functions, so no two can disagree about the wire. Shapes
// mirror service/voiceover_api.py and service/revoice_api.py's _PUBLIC_KEYS.
//
// SCOPE, stated: the marquee renders the VOICEOVER half (a silent video gets a
// narration). The re-voice half — `submitRevoice`, `SceneLine`, `RevoiceFit` —
// is the client for /v1/revoice, which the service ships and the studio has no
// surface for yet. It is kept here rather than deleted because the proxy routes
// under app/api/revoice are its other half; nothing renders it today.

import { useEffect, useRef, useState } from "react";
import { apiJson, throwDetail } from "@/lib/apiFetch";

export type StudioKind = "voiceover" | "revoice";

export type StudioStep = { key: string; label: string; state: "pending" | "active" | "done" };

export type VoiceoverFit = {
  scene: number;
  text: string;
  emotion: string;
  stem_fallback: boolean;
  seconds: number | null;
  budget_seconds: number | null;
  spill_seconds: number;
  clipped_seconds: number;
  silent: boolean;
  error: string | null;
};

export type RevoiceFit = {
  i: number;
  character_id: string;
  emotion?: string;
  stem_fallback?: boolean;
  emotion_requested?: string | null;
  budget_seconds: number;
  seconds?: number;
  method: "verbatim" | "atempo" | "rewrite" | "rewrite+atempo" | "spill" | null;
  atempo?: number | null;
  rewritten_text?: string | null;
  /** the LADDER's estimate: spoken-vs-budget, computed per line in isolation
   *  before anything was assembled. A prediction, and it can be wrong. */
  spill_seconds?: number;
  // ── what is actually in the rendered mp4 (service/revoice_api.py::_measure)
  // Optional on purpose: jobs from before the mux started reporting, and the
  // voiceover half, do not carry them. Presence of `in_track` is the signal
  // that this run was MEASURED — never infer it from a zero.
  /** overrun measured against the assembled track */
  track_spill_seconds?: number;
  /** seconds of this line lost at the end of the video */
  track_clipped_seconds?: number;
  /** any of this line is audible in the finished file */
  in_track?: boolean;
  error: string | null;
};

/** The run's counts, as the box summarises them. Loose by design (both halves
 *  and older jobs contribute different keys) but the ones the UI reads are
 *  named — including the pair that must never be conflated: `spilling` is the
 *  ladder's estimate, `spilling_in_track` is the finished file. */
export type RunSummary = {
  [key: string]: number | undefined;
  lines?: number;
  verbatim?: number;
  atempo?: number;
  rewritten?: number;
  spilling?: number;
  spilling_in_track?: number;
  clipped?: number;
  silent_in_track?: number;
  failed?: number;
};

export type StudioJob = {
  id: string;
  status: "running" | "done" | "error" | "cancelled" | "expired";
  step: string;
  steps: StudioStep[];
  partial: {
    video?: { seconds: number; width: number; height: number };
    scenes?: number;
    frames?: number;
    described?: number;
    lines?: number;
    words?: number;
    directed?: number;
    spoken_done?: number;
    spoken_total?: number;
  };
  error: string | null;
  source: { kind: string; url?: string; title?: string; trimmed?: boolean };
  brain: { backend: string; model?: string } | null;
  limits: string[];
  result: {
    summary: RunSummary;
    fit: (VoiceoverFit | RevoiceFit)[];
  } | null;
};

export type SceneLine = {
  character_id: string;
  text: string;
  start: number;
  end: number;
};

export function mediaUrl(kind: StudioKind, jobId: string, asset: "video" | "track"): string {
  return `/api/${kind}/${jobId}/media/${asset}`;
}

export function frameUrl(jobId: string, scene: number): string {
  return `/api/voiceover/${jobId}/frame/${scene}`;
}

export async function submitVoiceover(input: {
  url: string;
  character_id: string;
  style: string;
  language: string;
}): Promise<{ job_id: string }> {
  return apiJson<{ job_id: string }>(
    "/api/voiceover/from-url",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    "the voiceover could not be started",
  );
}

export async function submitRevoice(input: {
  url: string;
  lines: SceneLine[];
  direct: boolean;
  rewrite: boolean;
}): Promise<{ job_id: string }> {
  return apiJson<{ job_id: string }>(
    "/api/revoice",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    "the re-voice could not be started",
  );
}

/** Abandon a running job. THROWS when the box did not agree — the caller must
 *  not clear its view on a cancel that never happened; the render is still
 *  burning on the box and the user has to be told so.
 *
 *  A 404 is the one non-OK answer that is NOT a failure: the job already aged
 *  out of the registry (`errors.job_expired`), so there is nothing left running
 *  and clearing the view is the truthful outcome. */
export async function cancelJob(kind: StudioKind, jobId: string): Promise<void> {
  const r = await fetch(`/api/${kind}/${jobId}`, { method: "DELETE" });
  if (r.ok || r.status === 404) return;
  await throwDetail(r, "the cancel request was refused");
}

/** Poll one studio job until it lands. The compact sibling of ingest's
 *  useIngestJob: step-reset backoff (1.5s fresh step → 5s stale), slower in
 *  hidden tabs, transport failures retry forever but report `stalled` after
 *  three in a row so the UI can say the connection is degraded instead of
 *  animating a healthy loader. */
export function useStudioJob(kind: StudioKind, jobId: string | null) {
  const [job, setJob] = useState<StudioJob | null>(null);
  const [stalled, setStalled] = useState(false);
  const stepSince = useRef<{ step: string; at: number }>({ step: "", at: 0 });
  const failures = useRef(0);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setStalled(false);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Per-JOB counters. Kept in refs so a re-render cannot reset them, but
    // re-armed here: a previous job that ended stalled must not make the next
    // job's first hiccup report a degraded connection.
    failures.current = 0;
    stepSince.current = { step: "", at: 0 };

    const delay = (step: string) => {
      if (document.visibilityState === "hidden") return 30_000;
      const now = Date.now();
      if (stepSince.current.step !== step) stepSince.current = { step, at: now };
      const inStep = now - stepSince.current.at;
      return inStep < 20_000 ? 1500 : inStep < 40_000 ? 3000 : 5000;
    };

    const tick = async () => {
      let next = 3000;
      try {
        const j = await apiJson<StudioJob>(
          `/api/${kind}/${jobId}`, { cache: "no-store" }, "job unreachable",
        );
        if (!live) return;
        failures.current = 0;
        setStalled(false);
        setJob(j);
        if (j.status !== "running") return; // terminal — stop polling
        next = delay(j.step);
      } catch {
        if (!live) return;
        failures.current += 1;
        if (failures.current >= 3) setStalled(true);
        next = 5000;
      }
      timer = setTimeout(tick, next);
    };

    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible" && live) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [kind, jobId]);

  return { job, stalled };
}

// ── the written script, per scene ────────────────────────────────────────────

export type ScriptLine = {
  scene: number;
  text: string;
  emotion: string;
  emotion_requested: string | null;
  budget_words: number;
  words: number;
  seconds?: number;
  error?: string;
};

/** The narration plan the brain wrote (script.json) — the editable artifact. */
export async function loadScript(jobId: string): Promise<ScriptLine[]> {
  return apiJson<ScriptLine[]>(
    `/api/voiceover/${jobId}/media/script`, { cache: "no-store" },
    "the narration script could not be loaded",
  );
}

// (A per-scene `retakeLine` used to live here — a second synthesis path that
// spoke one scene straight to /api/speak. The marquee retired it: a scene is
// loaded into the console's own composer instead, so there is exactly ONE way
// words become audio on this page, with one set of knobs and one take log.)

// ── fit helpers ──────────────────────────────────────────────────────────────

export function isRevoiceFit(f: VoiceoverFit | RevoiceFit): f is RevoiceFit {
  return "method" in f;
}

/** What the box put in place of what was asked for, in one phrase — or null
 *  when nothing was substituted. Authored ONCE so a swapped emotion cannot be
 *  described two ways on two surfaces.
 *
 *  `stemFallback` is the backend's own flag (service/emotions.py::resolve): the
 *  voice that spoke this line came from a slot this Character has not actually
 *  recorded — a nearest-measured or derived stand-in — which is true even when
 *  the emotion's NAME is the one that was asked for. Silence about it would be
 *  the console presenting a computed stand-in as a performance. */
export function substitution(input: {
  requested?: string | null;
  delivered?: string | null;
  stemFallback?: boolean;
}): string | null {
  const { requested, delivered, stemFallback } = input;
  if (requested && requested !== delivered) {
    return `asked for ${requested} · spoken ${delivered || "baseline"}`;
  }
  if (stemFallback) return `no recorded ${delivered || "emotion"} — a stand-in was used`;
  return null;
}

/** The label a fit meter carries. Authored once so no two surfaces can drift
 *  into different words for the same measured fact. */
export function fitVerdict(f: VoiceoverFit | RevoiceFit): {
  tone: "ok" | "warn" | "muted" | "error";
  label: string;
} {
  if (f.error) return { tone: "error", label: "failed" };
  if (isRevoiceFit(f)) {
    // MEASURED beats predicted. `in_track` present means the mux reported on
    // this line; from there the track's numbers are the facts and the ladder's
    // estimate is only the rung that explains HOW the line got there. The two
    // are never added together and never silently swapped for one another.
    const measured = f.in_track !== undefined;
    if (measured && !f.in_track) {
      return { tone: "error", label: "not in the track" };
    }
    const spill = measured ? (f.track_spill_seconds ?? 0) : (f.spill_seconds ?? 0);
    const clipped = f.track_clipped_seconds ?? 0;
    const rung =
      f.method === "verbatim" ? "verbatim"
      : f.method === "atempo" ? `atempo ×${f.atempo ?? "?"}`
      : f.method === "rewrite" ? "rewritten"
      : f.method === "rewrite+atempo" ? `rewritten ×${f.atempo ?? "?"}`
      : "";
    const notes: string[] = [];
    if (clipped) notes.push(`clipped ${clipped}s`);
    if (spill) notes.push(`spills ${spill}s`);
    if (notes.length) return { tone: "warn", label: [rung, ...notes].filter(Boolean).join(" · ") };
    // The ladder gave up and let this one run long. Measured, the track says it
    // did not overrun after all — that is the fact. Unmeasured, the ladder's
    // verdict stands, without a number it does not have.
    if (f.method === "spill") {
      return measured ? { tone: "ok", label: "fits the track" } : { tone: "warn", label: "spills" };
    }
    return rung ? { tone: "ok", label: rung } : { tone: "muted", label: "—" };
  }
  if (f.silent) return { tone: "muted", label: "silent" };
  if (f.clipped_seconds) return { tone: "warn", label: `clipped ${f.clipped_seconds}s` };
  if (f.spill_seconds) return { tone: "warn", label: `spills ${f.spill_seconds}s` };
  return { tone: "ok", label: "fits" };
}
