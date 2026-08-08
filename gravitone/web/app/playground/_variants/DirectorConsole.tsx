"use client";

// DIRECTOR CONSOLE — the playground console gains a picture. Same DNA as the
// console that won round one (character rail on the left, one composer in the
// middle, expression knobs on the right), but the composer is SCENE-AWARE: a
// reference monitor and a filmstrip sit above it, and the text being directed
// is always one scene's narration line. One scene in focus at a time — the
// console's "one take under the needle" discipline, applied to video.

import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Eyebrow, Panel } from "@/components/ui/Primitives";
import { rise } from "@/components/ui/tokens";
import { ApiError } from "@/lib/apiFetch";
import EmotionChips from "./EmotionChips";
import {
  cancelJob, frameUrl, loadScript, mediaUrl, retakeLine, submitVoiceover,
  useStudioJob, type ScriptLine, type VoiceoverFit,
} from "./videoData";
import { FitMeter, StepsRail, useRoster } from "./videoShared";

export default function DirectorConsole() {
  const { roster, rosterError } = useRoster();
  const [url, setUrl] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [style, setStyle] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { job, stalled } = useStudioJob("voiceover", jobId);

  const [script, setScript] = useState<ScriptLine[] | null>(null);
  const [focus, setFocus] = useState(0);

  const character = useMemo(
    () => (roster ?? []).find((c) => c.character_id === characterId) ?? null,
    [roster, characterId],
  );

  // the written script arrives once the job lands
  useEffect(() => {
    if (job?.status !== "done" || !jobId) return;
    let live = true;
    loadScript(jobId)
      .then((s) => { if (live) setScript(s); })
      .catch(() => { if (live) setScript(null); });
    return () => { live = false; };
  }, [job?.status, jobId]);

  const fit = (job?.result?.fit ?? []) as VoiceoverFit[];
  const focused = script?.find((l) => l.scene === focus) ?? null;
  const focusedFit = fit.find((f) => f.scene === focus) ?? null;

  const submit = async () => {
    if (!url.trim() || !characterId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await submitVoiceover({
        url: url.trim(), character_id: characterId, style, language: "",
      });
      setJobId(res.job_id);
      setScript(null);
      setFocus(0);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "the job could not be started");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = async () => {
    if (jobId && job?.status === "running") await cancelJob("voiceover", jobId);
    setJobId(null);
    setScript(null);
    setError(null);
  };

  return (
    <div className="space-y-6">
      <motion.div variants={rise} initial="hidden" animate="show">
        <Eyebrow>playground · director cut</Eyebrow>
        <h1 className="font-instrument mt-3 text-4xl text-white">Direct the picture</h1>
        <p className="font-hanken mt-2 max-w-2xl text-base text-slate-300">
          The console you know, with a monitor above it. One scene under the needle at a
          time — pick it on the strip, direct its line, retake it in this character&apos;s own stems.
        </p>
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        {/* ── character rail ─────────────────────────────────────────── */}
        <motion.aside variants={rise} initial="hidden" animate="show" custom={1}>
          <Panel className="p-4">
            <p className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">narrator</p>
            <div className="mt-3 space-y-1.5">
              {roster === null && (
                <p className="font-jetbrains text-[11px] text-white/40">loading characters…</p>
              )}
              {(roster ?? []).map((c) => {
                const on = c.character_id === characterId;
                return (
                  <button
                    key={c.character_id}
                    onClick={() => setCharacterId(c.character_id)}
                    aria-pressed={on}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                      on ? "border-cyan-300/40 bg-cyan-300/10" : "border-white/8 hover:border-white/25"
                    }`}
                  >
                    <span className={`font-hanken block text-sm ${on ? "text-white" : "text-white/75"}`}>
                      {c.name}
                    </span>
                    <span className="font-jetbrains text-[11px] text-white/40">
                      {c.lang || "en"} · {c.coverage}/{c.total} emotions
                    </span>
                  </button>
                );
              })}
            </div>
            {rosterError && <ErrorBanner>{rosterError}</ErrorBanner>}
          </Panel>
        </motion.aside>

        {/* ── the composer, scene-aware ──────────────────────────────── */}
        <motion.div variants={rise} initial="hidden" animate="show" custom={2}>
          <Panel className="p-5">
            {!jobId && (
              <div className="space-y-4">
                <div>
                  <label htmlFor="dc-url" className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                    the picture
                  </label>
                  <input
                    id="dc-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=…"
                    className="font-hanken mt-2 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
                  />
                </div>
                <div>
                  <label htmlFor="dc-style" className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                    direction to the writer
                  </label>
                  <input
                    id="dc-style" value={style} onChange={(e) => setStyle(e.target.value)}
                    placeholder="tone, pace, audience…"
                    className="font-hanken mt-2 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Button onClick={submit} disabled={!url.trim() || !characterId || submitting}>
                    {submitting ? "reading the picture…" : "read the picture"}
                  </Button>
                  {!characterId && (
                    <span className="font-jetbrains text-[11px] text-white/45">pick a narrator first</span>
                  )}
                </div>
                {error && <ErrorBanner>{error}</ErrorBanner>}
              </div>
            )}

            {jobId && job && job.status === "running" && (
              <div className="space-y-4">
                <p className="font-hanken text-lg text-white">{job.source.title ?? url}</p>
                <StepsRail job={job} stalled={stalled} />
                <Button variant="ghost" onClick={reset}>cut &amp; discard</Button>
              </div>
            )}
            {jobId && job?.status === "error" && (
              <div className="space-y-4">
                <ErrorBanner>{job.error}</ErrorBanner>
                <Button variant="ghost" onClick={reset}>start over</Button>
              </div>
            )}
            {jobId && job?.status === "expired" && (
              <div className="space-y-4">
                <ErrorBanner>this session aged out on the box — read the picture again</ErrorBanner>
                <Button variant="ghost" onClick={reset}>start over</Button>
              </div>
            )}

            {jobId && job?.status === "done" && job.result && (
              <div className="space-y-5">
                {/* reference monitor */}
                <video
                  src={mediaUrl("voiceover", jobId, "video")} controls
                  className="max-h-72 w-full rounded-xl border border-white/8 bg-black"
                />
                {/* filmstrip — the scene picker */}
                <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="scenes">
                  {fit.map((f) => {
                    const on = f.scene === focus;
                    return (
                      <button
                        key={f.scene} role="tab" aria-selected={on}
                        onClick={() => setFocus(f.scene)}
                        className={`shrink-0 rounded-md border transition ${
                          on ? "border-cyan-300/60" : "border-white/8 hover:border-white/30"
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={frameUrl(jobId, f.scene)} alt={`scene ${f.scene + 1}`}
                          className={`h-16 w-28 rounded-md object-cover ${on ? "" : "opacity-60"}`}
                        />
                      </button>
                    );
                  })}
                </div>

                {/* the needle: one scene's line, directable */}
                {focused && focusedFit && character ? (
                  <SceneDirector
                    key={focus}
                    line={focused}
                    fit={focusedFit}
                    characterId={character.character_id}
                    scale={character.scale ?? character.emotions}
                    recorded={character.emotions}
                  />
                ) : (
                  <p className="font-jetbrains text-[12px] text-white/45">
                    {script === null ? "the script could not be loaded — the reel still plays" : "pick a scene on the strip"}
                  </p>
                )}

                {job.limits.length > 0 && (
                  <ErrorBanner severity="warning" className="mt-0">{job.limits.join(" · ")}</ErrorBanner>
                )}
                <div className="flex gap-3">
                  <a href={mediaUrl("voiceover", jobId, "video")} download>
                    <Button variant="ghost">download reel</Button>
                  </a>
                  <Button variant="ghost" onClick={reset}>new picture</Button>
                </div>
              </div>
            )}
          </Panel>
        </motion.div>
      </div>
    </div>
  );
}

/** One scene under the needle: its line, its emotion, its fit — and a retake
 *  through the console's own /api/speak. The retake is a PREVIEW: the reel
 *  keeps its first render until a re-mux ships, and the copy says so. */
function SceneDirector({ line, fit, characterId, scale, recorded }: {
  line: ScriptLine;
  fit: VoiceoverFit;
  characterId: string;
  scale: string[];
  recorded: string[];
}) {
  const [text, setText] = useState(line.text);
  const [emotion, setEmotion] = useState(line.emotion);
  const [rendering, setRendering] = useState(false);
  const [takeUrl, setTakeUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => { if (takeUrl) URL.revokeObjectURL(takeUrl); }, [takeUrl]);

  const retake = async () => {
    if (rendering || !text.trim()) return;
    setRendering(true);
    setErr(null);
    try {
      const blob = await retakeLine({ character_id: characterId, emotion, text: text.trim() });
      const u = URL.createObjectURL(blob);
      setTakeUrl((old) => { if (old) URL.revokeObjectURL(old); return u; });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "the retake could not be rendered");
    } finally {
      setRendering(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
          scene {line.scene + 1} · budget {line.budget_words} words
        </p>
        <span className="font-jetbrains text-[11px] text-white/45">
          {fit.budget_seconds ? `${fit.budget_seconds.toFixed(1)}s on screen` : ""}
        </span>
      </div>
      <textarea
        value={text} onChange={(e) => setText(e.target.value)} rows={3}
        className="font-hanken mt-3 w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
        aria-label={`scene ${line.scene + 1} narration`}
      />
      <div className="mt-3">
        <EmotionChips scale={scale} recorded={recorded} onPick={setEmotion} />
        <p className="font-jetbrains mt-1 text-[11px] text-white/45">
          directing: <span className="text-cyan-200">{emotion}</span>
          {line.emotion_requested ? ` · the writer asked for ${line.emotion_requested} (not recorded)` : ""}
        </p>
      </div>
      <div className="mt-3"><FitMeter fit={fit} /></div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={retake} disabled={rendering || !text.trim()}>
          {rendering ? "rendering…" : "retake this scene"}
        </Button>
        {takeUrl && <audio ref={audioRef} src={takeUrl} controls className="h-9" />}
        <span className="font-jetbrains text-[11px] text-white/45">
          preview only — the reel keeps its first render
        </span>
      </div>
      {err && <ErrorBanner>{err}</ErrorBanner>}
    </div>
  );
}
