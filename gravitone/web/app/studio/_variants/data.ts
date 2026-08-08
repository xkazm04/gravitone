"use client";

// The studio's one data layer: both prototype variants read jobs, submit
// work and poll through THESE functions, so they can disagree about layout
// and never about the wire. Shapes mirror service/voiceover_api.py and
// service/revoice_api.py's _PUBLIC_KEYS.

import { useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/apiFetch";

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
  spill_seconds?: number;
  error: string | null;
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
    summary: Record<string, number>;
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

export async function cancelJob(kind: StudioKind, jobId: string): Promise<void> {
  await fetch(`/api/${kind}/${jobId}`, { method: "DELETE" });
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

// ── fit helpers both variants render from ────────────────────────────────────

export function isRevoiceFit(f: VoiceoverFit | RevoiceFit): f is RevoiceFit {
  return "method" in f;
}

/** The label a fit meter carries. Authored once so the two variants cannot
 *  drift into different words for the same measured fact. */
export function fitVerdict(f: VoiceoverFit | RevoiceFit): {
  tone: "ok" | "warn" | "muted" | "error";
  label: string;
} {
  if (f.error) return { tone: "error", label: "failed" };
  if (isRevoiceFit(f)) {
    switch (f.method) {
      case "verbatim":
        return { tone: "ok", label: "verbatim" };
      case "atempo":
        return { tone: "ok", label: `atempo ×${f.atempo ?? "?"}` };
      case "rewrite":
        return f.spill_seconds
          ? { tone: "warn", label: `rewritten · spills ${f.spill_seconds}s` }
          : { tone: "ok", label: "rewritten" };
      case "rewrite+atempo":
        return { tone: "ok", label: `rewritten ×${f.atempo ?? "?"}` };
      case "spill":
        return { tone: "warn", label: `spills ${f.spill_seconds ?? 0}s` };
      default:
        return { tone: "muted", label: "—" };
    }
  }
  if (f.silent) return { tone: "muted", label: "silent" };
  if (f.clipped_seconds) return { tone: "warn", label: `clipped ${f.clipped_seconds}s` };
  if (f.spill_seconds) return { tone: "warn", label: `spills ${f.spill_seconds}s` };
  return { tone: "ok", label: "fits" };
}
