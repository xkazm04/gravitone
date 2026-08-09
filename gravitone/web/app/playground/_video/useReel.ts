"use client";

// One reel, owned by the console. Both video directions call this — they
// disagree about where the picture goes, never about what a reel IS.
//
// The NARRATOR is the console's own selected Character (the rail above), not a
// second picker: the whole point of extending the playground rather than
// building a second page is that one roster, one selection, one set of
// expression knobs serve both the composer and the picture.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/apiFetch";
import {
  cancelJob, loadScript, submitVoiceover, useStudioJob,
  type ScriptLine, type VoiceoverFit,
} from "./videoData";

/** A scene as the console works with it: the picture's slot, the words that
 *  go in it, and how the last render fitted. */
export type Scene = {
  i: number;
  /** where this scene starts in the reel, DERIVED by tiling: the backend cuts
   *  scenes with no gaps and no overlap (service/frames.py::_coalesce), so the
   *  running sum of the budgets before it IS its start. Used to seek the
   *  monitor; never presented as a measurement of its own. */
  start: number;
  /** seconds of picture this line has to live in */
  budget: number;
  /** the words, as edited HERE (falls back to what the writer wrote) */
  text: string;
  /** what the writer wrote, kept so an edit can be told from the original */
  written: string;
  emotion: string;
  /** an emotion the writer asked for that this Character has not recorded */
  emotionRequested: string | null;
  budgetWords: number;
  fit: VoiceoverFit | null;
  edited: boolean;
};

export function useReel({ characterId }: { characterId: string }) {
  const [url, setUrl] = useState("");
  const [style, setStyle] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [script, setScript] = useState<ScriptLine[] | null>(null);
  const [edits, setEdits] = useState<Record<number, { text?: string; emotion?: string }>>({});
  const [focus, setFocus] = useState(0);
  const { job, stalled } = useStudioJob("voiceover", jobId);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // The written script arrives with the finished job. A script that cannot be
  // read is NOT fatal — the reel still plays and the fit report still renders;
  // the scenes just carry the fit's own copy of the words.
  useEffect(() => {
    if (job?.status !== "done" || !jobId) return;
    let live = true;
    loadScript(jobId)
      .then((s) => { if (live) setScript(s); })
      .catch(() => { if (live) setScript(null); });
    return () => { live = false; };
  }, [job?.status, jobId]);

  const scenes = useMemo<Scene[]>(() => {
    const fits = (job?.result?.fit ?? []) as VoiceoverFit[];
    let clock = 0;
    return fits.map((f) => {
      const written = script?.find((l) => l.scene === f.scene);
      const base = written?.text ?? f.text ?? "";
      const edit = edits[f.scene];
      const start = clock;
      clock += f.budget_seconds ?? 0;
      return {
        i: f.scene,
        start,
        budget: f.budget_seconds ?? 0,
        text: edit?.text ?? base,
        written: base,
        emotion: edit?.emotion ?? written?.emotion ?? f.emotion ?? "baseline",
        emotionRequested: written?.emotion_requested ?? null,
        budgetWords: written?.budget_words ?? 0,
        fit: f,
        edited: edit?.text !== undefined && edit.text !== base,
      };
    });
  }, [job?.result, script, edits]);

  const patch = useCallback((i: number, p: { text?: string; emotion?: string }) => {
    setEdits((e) => ({ ...e, [i]: { ...e[i], ...p } }));
  }, []);

  const submit = useCallback(async () => {
    if (!url.trim() || !characterId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await submitVoiceover({
        url: url.trim(), character_id: characterId, style, language: "",
      });
      if (!mounted.current) return;
      setJobId(res.job_id);
      setScript(null);
      setEdits({});
      setFocus(0);
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof ApiError ? e.message : "the reel could not be started");
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }, [url, characterId, style, submitting]);

  const reset = useCallback(async () => {
    const id = jobId;
    const running = job?.status === "running";
    setJobId(null);
    setScript(null);
    setEdits({});
    setError(null);
    if (id && running) await cancelJob("voiceover", id);
  }, [jobId, job?.status]);

  return {
    url, setUrl, style, setStyle,
    jobId, job, stalled, submitting, error,
    scenes, focus, setFocus, patch,
    submit, reset,
    /** the reel is loaded and has scenes to work with */
    ready: job?.status === "done" && scenes.length > 0,
  };
}

export type Reel = ReturnType<typeof useReel>;
