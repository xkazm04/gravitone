"use client";

// STORYBOARD — the whole film on the desk at once. Where the director cut
// focuses one scene under a needle, the storyboard lays every scene out as a
// row (frame | line | direction) and you work across them like panels of a
// comic. The playground's TTS control lives INSIDE each row: emotion select
// from the character's real stems, retake per row, fit drawn to scale.

import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Eyebrow, Panel } from "@/components/ui/Primitives";
import { rise } from "@/components/ui/tokens";
import { ApiError } from "@/lib/apiFetch";
import {
  cancelJob, frameUrl, loadScript, mediaUrl, retakeLine, submitVoiceover,
  useStudioJob, type ScriptLine, type VoiceoverFit,
} from "./videoData";
import { CharacterSelect, FitMeter, StepsRail, tc, useRoster } from "./videoShared";

export default function Storyboard() {
  const { roster, rosterError } = useRoster();
  const [url, setUrl] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [style, setStyle] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { job, stalled } = useStudioJob("voiceover", jobId);
  const [script, setScript] = useState<ScriptLine[] | null>(null);

  const character = useMemo(
    () => (roster ?? []).find((c) => c.character_id === characterId) ?? null,
    [roster, characterId],
  );

  useEffect(() => {
    if (job?.status !== "done" || !jobId) return;
    let live = true;
    loadScript(jobId)
      .then((s) => { if (live) setScript(s); })
      .catch(() => { if (live) setScript(null); });
    return () => { live = false; };
  }, [job?.status, jobId]);

  const fit = (job?.result?.fit ?? []) as VoiceoverFit[];

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
        <Eyebrow>playground · storyboard</Eyebrow>
        <h1 className="font-instrument mt-3 text-4xl text-white">The board</h1>
        <p className="font-hanken mt-2 max-w-2xl text-base text-slate-300">
          Every scene on the desk at once — frame, line, direction, fit. Work across the
          panels; retake any of them in the narrator&apos;s own stems.
        </p>
      </motion.div>

      {/* ── the pitch (door) ─────────────────────────────────────────── */}
      {!jobId && (
        <motion.div variants={rise} initial="hidden" animate="show" custom={1}>
          <Panel className="p-5">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="md:col-span-2">
                <label htmlFor="sb-url" className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                  footage
                </label>
                <input
                  id="sb-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=…"
                  className="font-hanken mt-2 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
                />
              </div>
              <div>
                <label htmlFor="sb-char" className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                  narrator
                </label>
                <div className="mt-2">
                  <CharacterSelect id="sb-char" roster={roster} value={characterId} onChange={setCharacterId} />
                </div>
              </div>
            </div>
            <div className="mt-4">
              <label htmlFor="sb-style" className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                the pitch — how should this feel?
              </label>
              <input
                id="sb-style" value={style} onChange={(e) => setStyle(e.target.value)}
                placeholder="playful nature-doc… solemn archive footage… fast product demo…"
                className="font-hanken mt-2 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
              />
            </div>
            <div className="mt-5">
              <Button onClick={submit} disabled={!url.trim() || !characterId || submitting}>
                {submitting ? "boarding…" : "board it"}
              </Button>
            </div>
            {rosterError && <ErrorBanner>{rosterError}</ErrorBanner>}
            {error && <ErrorBanner>{error}</ErrorBanner>}
          </Panel>
        </motion.div>
      )}

      {/* ── in progress / failed ─────────────────────────────────────── */}
      {jobId && job && job.status !== "done" && (
        <motion.div variants={rise} initial="hidden" animate="show">
          <Panel className="p-5">
            <p className="font-hanken text-lg text-white">{job.source.title ?? url}</p>
            {job.status === "running" && <div className="mt-4"><StepsRail job={job} stalled={stalled} /></div>}
            {job.status === "error" && <ErrorBanner>{job.error}</ErrorBanner>}
            {job.status === "expired" && (
              <ErrorBanner>this session aged out on the box — board it again</ErrorBanner>
            )}
            <div className="mt-4">
              <Button variant="ghost" onClick={reset}>
                {job.status === "running" ? "tear it down" : "start over"}
              </Button>
            </div>
          </Panel>
        </motion.div>
      )}

      {/* ── the board ────────────────────────────────────────────────── */}
      {jobId && job?.status === "done" && job.result && (
        <div className="space-y-4">
          <motion.div variants={rise} initial="hidden" animate="show">
            <Panel className="p-4">
              <div className="grid gap-4 md:grid-cols-[minmax(0,420px)_1fr]">
                <video
                  src={mediaUrl("voiceover", jobId, "video")} controls
                  className="w-full rounded-lg border border-white/8 bg-black"
                />
                <div className="font-jetbrains self-center text-[12px] leading-6 text-white/55">
                  <p className="text-white">{job.source.title}</p>
                  <p>
                    {job.partial.video ? `${tc(job.partial.video.seconds)} · ` : ""}
                    {fit.length} scenes · {job.result.summary.spoken ?? 0} spoken ·{" "}
                    {job.result.summary.silent ?? 0} silent
                    {job.brain ? ` · brain: ${job.brain.backend}` : ""}
                  </p>
                  {(job.result.summary.spilling ?? 0) > 0 && (
                    <p className="text-amber-200">{job.result.summary.spilling} scene(s) spill their slot</p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <a href={mediaUrl("voiceover", jobId, "video")} download>
                      <Button variant="ghost">download</Button>
                    </a>
                    <Button variant="ghost" onClick={reset}>new board</Button>
                  </div>
                </div>
              </div>
              {job.limits.length > 0 && (
                <ErrorBanner severity="warning">{job.limits.join(" · ")}</ErrorBanner>
              )}
            </Panel>
          </motion.div>

          {fit.map((f, i) => (
            <motion.div key={f.scene} variants={rise} initial="hidden" animate="show"
                        custom={Math.min(i, 6)}>
              <Panel className="p-4">
                <PanelRow
                  jobId={jobId}
                  fit={f}
                  line={script?.find((l) => l.scene === f.scene) ?? null}
                  characterId={characterId}
                  emotions={character?.emotions ?? ["baseline"]}
                />
              </Panel>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One storyboard panel: frame | the line (editable) | direction + fit. */
function PanelRow({ jobId, fit, line, characterId, emotions }: {
  jobId: string;
  fit: VoiceoverFit;
  line: ScriptLine | null;
  characterId: string;
  emotions: string[];
}) {
  const [text, setText] = useState(line?.text ?? fit.text);
  const [emotion, setEmotion] = useState(line?.emotion ?? fit.emotion ?? "baseline");
  const [rendering, setRendering] = useState(false);
  const [takeUrl, setTakeUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    if (takeUrl) URL.revokeObjectURL(takeUrl);
  }, [takeUrl]);

  const retake = async () => {
    if (rendering || !text.trim()) return;
    setRendering(true);
    setErr(null);
    try {
      const blob = await retakeLine({ character_id: characterId, emotion, text: text.trim() });
      if (!mounted.current) return;
      const u = URL.createObjectURL(blob);
      setTakeUrl((old) => { if (old) URL.revokeObjectURL(old); return u; });
    } catch (e) {
      if (mounted.current) setErr(e instanceof ApiError ? e.message : "the retake could not be rendered");
    } finally {
      if (mounted.current) setRendering(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-[176px_1fr_220px]">
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={frameUrl(jobId, fit.scene)} alt={`scene ${fit.scene + 1}`}
          className="aspect-video w-full rounded-md border border-white/8 object-cover"
        />
        <p className="font-jetbrains mt-1 text-[11px] text-white/45">
          #{fit.scene + 1} · {fit.budget_seconds ? `${fit.budget_seconds.toFixed(1)}s` : "—"}
        </p>
      </div>
      <div>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={3}
          placeholder="(the writer chose silence — write something to speak here)"
          className="font-hanken w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
          aria-label={`scene ${fit.scene + 1} narration`}
        />
        {line?.emotion_requested && (
          <p className="font-jetbrains mt-1 text-[11px] text-amber-200">
            the writer asked for {line.emotion_requested} — not recorded for this narrator
          </p>
        )}
        {err && <ErrorBanner className="mt-2">{err}</ErrorBanner>}
      </div>
      <div className="flex flex-col gap-2">
        <select
          value={emotion} onChange={(e) => setEmotion(e.target.value)}
          aria-label={`scene ${fit.scene + 1} emotion`}
          className="font-jetbrains w-full rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-white outline-none transition focus:border-cyan-300/50"
        >
          {emotions.map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
        <FitMeter fit={fit} />
        <Button variant="ghost" className="px-4 py-2 text-[12px]" onClick={retake}
                disabled={rendering || !text.trim()}>
          {rendering ? "rendering…" : "retake"}
        </Button>
        {takeUrl && <audio src={takeUrl} controls className="h-8 w-full" />}
        <span className="font-jetbrains text-[11px] leading-4 text-white/40">
          preview only — the reel keeps its first render
        </span>
      </div>
    </div>
  );
}
