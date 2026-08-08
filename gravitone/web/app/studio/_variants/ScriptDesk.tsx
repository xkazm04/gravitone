"use client";

// SCRIPT DESK — the script is the spine. One central metaphor: a table read.
// The page is a screenplay (slug lines, centered character names, dialogue
// column, parentheticals for emotion); the video is a small monitor on the
// side of the desk. Fit facts sit in the right margin of each line, where a
// script supervisor writes timings.

import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Eyebrow, Panel } from "@/components/ui/Primitives";
import { rise } from "@/components/ui/tokens";
import { ApiError } from "@/lib/apiFetch";
import {
  cancelJob, isRevoiceFit, mediaUrl, submitRevoice, submitVoiceover,
  useStudioJob, type SceneLine, type StudioKind,
} from "./data";
import { CharacterSelect, FitMeter, StepsRail, tc, useRoster } from "./shared";

export default function ScriptDesk() {
  const { roster, rosterError } = useRoster();
  const [mode, setMode] = useState<StudioKind>("revoice");
  const [url, setUrl] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [style, setStyle] = useState("");
  const [lines, setLines] = useState<SceneLine[]>([
    { character_id: "", text: "", start: 0, end: 5 },
  ]);
  const [jobRef, setJobRef] = useState<{ kind: StudioKind; id: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { job, stalled } = useStudioJob(jobRef?.kind ?? "revoice", jobRef?.id ?? null);

  const nameOf = useMemo(() => {
    const m = new Map((roster ?? []).map((c) => [c.character_id, c.name]));
    return (id: string) => m.get(id) ?? id;
  }, [roster]);

  const canSubmit = useMemo(() => {
    if (!url.trim() || submitting) return false;
    if (mode === "voiceover") return Boolean(characterId);
    return lines.length > 0 && lines.every((l) => l.character_id && l.text.trim() && l.end > l.start);
  }, [url, submitting, mode, characterId, lines]);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = mode === "voiceover"
        ? await submitVoiceover({ url: url.trim(), character_id: characterId, style, language: "" })
        : await submitRevoice({ url: url.trim(), lines, direct: true, rewrite: true });
      setJobRef({ kind: mode, id: res.job_id });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "the job could not be started");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = async () => {
    if (jobRef && job?.status === "running") await cancelJob(jobRef.kind, jobRef.id);
    setJobRef(null);
    setError(null);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      {/* ── the script ─────────────────────────────────────────────────── */}
      <div>
        <motion.div variants={rise} initial="hidden" animate="show">
          <Eyebrow>studio · script desk</Eyebrow>
          <h1 className="font-instrument mt-3 text-4xl text-white">The table read</h1>
        </motion.div>

        <motion.div variants={rise} initial="hidden" animate="show" custom={1}>
          <Panel className="mt-6 p-6 md:p-10">
            {/* title page block — the door */}
            {!jobRef && (
              <div className="mx-auto max-w-xl">
                <div className="flex justify-center gap-2">
                  <DeskTab on={mode === "revoice"} onClick={() => setMode("revoice")} label="re-voice" />
                  <DeskTab on={mode === "voiceover"} onClick={() => setMode("voiceover")} label="voiceover" />
                </div>
                <p className="font-jetbrains mt-6 text-center text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                  based on the video
                </p>
                <input
                  type="url" value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=…" aria-label="source video"
                  className="font-hanken mt-2 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-center text-base text-white outline-none transition focus:border-cyan-300/50"
                />
                {mode === "voiceover" && (
                  <>
                    <p className="font-jetbrains mt-5 text-center text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                      narrated by
                    </p>
                    <div className="mt-2">
                      <CharacterSelect roster={roster} value={characterId} onChange={setCharacterId} />
                    </div>
                    <p className="font-jetbrains mt-5 text-center text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                      a note to the writer
                    </p>
                    <input
                      value={style} onChange={(e) => setStyle(e.target.value)}
                      placeholder="tone, pace, audience…" aria-label="style brief"
                      className="font-hanken mt-2 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-center text-base text-white outline-none transition focus:border-cyan-300/50"
                    />
                    <p className="font-hanken mt-6 text-center text-sm text-white/45">
                      the scenes are read from the picture — the script writes itself at the read
                    </p>
                  </>
                )}
              </div>
            )}

            {/* the screenplay body */}
            {!jobRef && mode === "revoice" && (
              <div className="mx-auto mt-8 max-w-xl space-y-7">
                {lines.map((l, i) => (
                  <div key={i} className="group">
                    <p className="font-jetbrains text-[11px] text-white/35">
                      {tc(l.start)} → {tc(l.end)}
                      <button
                        onClick={() => setLines(lines.filter((_, k) => k !== i))}
                        className="ml-3 text-white/30 opacity-0 transition group-hover:opacity-100 hover:text-rose-300"
                        aria-label={`remove line ${i + 1}`}
                      >
                        strike
                      </button>
                    </p>
                    <div className="mt-1 grid grid-cols-[110px_1fr] items-start gap-3">
                      <CharacterSelect roster={roster} value={l.character_id}
                                       onChange={(id) => edit(lines, setLines, i, { character_id: id })} />
                      <textarea
                        value={l.text} rows={2}
                        onChange={(e) => edit(lines, setLines, i, { text: e.target.value })}
                        placeholder="the line as the scan heard it — edit freely"
                        className="font-hanken w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
                      />
                    </div>
                    <div className="mt-1 flex justify-end gap-3">
                      <NumField label="in" value={l.start}
                                onChange={(v) => edit(lines, setLines, i, { start: v })} />
                      <NumField label="out" value={l.end}
                                onChange={(v) => edit(lines, setLines, i, { end: v })} />
                    </div>
                  </div>
                ))}
                <div className="text-center">
                  <button
                    onClick={() => setLines([...lines, {
                      character_id: lines[lines.length - 1]?.character_id ?? "",
                      text: "",
                      start: lines[lines.length - 1]?.end ?? 0,
                      end: (lines[lines.length - 1]?.end ?? 0) + 5,
                    }])}
                    className="font-jetbrains text-[12px] uppercase tracking-[0.14em] text-white/45 transition hover:text-cyan-200"
                  >
                    + next line
                  </button>
                </div>
              </div>
            )}

            {/* the read — script rendered from the result */}
            {jobRef && job?.status === "done" && job.result && (
              <div className="mx-auto max-w-xl space-y-7">
                {job.result.fit.map((f, idx) => {
                  const n = isRevoiceFit(f) ? f.i : f.scene;
                  const who = isRevoiceFit(f)
                    ? nameOf(f.character_id)
                    : nameOf(characterId) || "narrator";
                  const text = isRevoiceFit(f)
                    ? f.rewritten_text || (lines[n]?.text ?? "")
                    : f.text;
                  return (
                    <div key={idx}>
                      <p className="font-jetbrains text-[11px] text-white/35">
                        scene {n + 1}
                        {f.budget_seconds ? ` · ${f.budget_seconds.toFixed(1)}s on screen` : ""}
                      </p>
                      <p className="font-jetbrains mt-2 text-center text-[13px] uppercase tracking-[0.2em] text-white">
                        {who}
                      </p>
                      {(isRevoiceFit(f) ? f.emotion : f.emotion) !== "baseline" && (
                        <p className="font-hanken text-center text-sm text-white/45">
                          ({isRevoiceFit(f) ? f.emotion : f.emotion})
                        </p>
                      )}
                      <p className={`font-hanken mx-auto mt-1 max-w-md text-center text-base ${
                        f.error ? "text-rose-200" : text ? "text-slate-200" : "text-white/40 italic"
                      }`}>
                        {f.error ? f.error : text || "(the writer chose silence here)"}
                      </p>
                      {isRevoiceFit(f) && f.rewritten_text && (
                        <p className="font-jetbrains mt-1 text-center text-[11px] text-amber-200">
                          rewritten to fit — the original is not what plays
                        </p>
                      )}
                      <div className="mx-auto mt-2 max-w-xs"><FitMeter fit={f} /></div>
                    </div>
                  );
                })}
              </div>
            )}

            {jobRef && job && job.status !== "done" && (
              <div className="mx-auto max-w-md py-6">
                {job.status === "running" && <StepsRail job={job} stalled={stalled} />}
                {job.status === "error" && <ErrorBanner>{job.error}</ErrorBanner>}
                {job.status === "expired" && (
                  <ErrorBanner>this session aged out on the box — start it again</ErrorBanner>
                )}
              </div>
            )}

            {!jobRef && (
              <div className="mt-8 text-center">
                <Button onClick={submit} disabled={!canSubmit}>
                  {submitting ? "gathering the table…" : "begin the read"}
                </Button>
                {rosterError && <ErrorBanner>{rosterError}</ErrorBanner>}
                {error && <ErrorBanner>{error}</ErrorBanner>}
              </div>
            )}
          </Panel>
        </motion.div>
      </div>

      {/* ── the side monitor ───────────────────────────────────────────── */}
      <motion.aside variants={rise} initial="hidden" animate="show" custom={2}
                    className="lg:sticky lg:top-6 lg:self-start">
        <Panel className="p-4">
          <p className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">monitor</p>
          {jobRef && job?.status === "done" ? (
            <video
              src={mediaUrl(jobRef.kind, jobRef.id, "video")} controls
              className="mt-3 w-full rounded-lg border border-white/8 bg-black"
            />
          ) : (
            <div className="font-jetbrains mt-3 grid aspect-video place-items-center rounded-lg border border-white/8 bg-black/40 text-[11px] uppercase tracking-[0.18em] text-white/30">
              {jobRef ? "printing…" : "no signal"}
            </div>
          )}
          {jobRef && job && (
            <dl className="font-jetbrains mt-4 space-y-1.5 text-[12px] text-white/55">
              <Row k="reel" v={job.source.title ?? "—"} />
              {job.partial.video && <Row k="length" v={tc(job.partial.video.seconds)} />}
              {job.brain && <Row k="brain" v={`${job.brain.backend}${job.brain.model ? ` · ${job.brain.model}` : ""}`} />}
              {job.result && <Row k="lines" v={String(job.result.summary.lines ?? job.result.summary.scenes ?? "—")} />}
              {job.result?.summary.spilling ? <Row k="spilling" v={String(job.result.summary.spilling)} warn /> : null}
            </dl>
          )}
          {jobRef && job && job.limits.length > 0 && (
            <ErrorBanner severity="warning">{job.limits.join(" · ")}</ErrorBanner>
          )}
          {jobRef && (
            <div className="mt-4 flex flex-col gap-2">
              {job?.status === "done" && (
                <a href={mediaUrl(jobRef.kind, jobRef.id, "video")} download>
                  <Button variant="ghost" className="w-full">download the print</Button>
                </a>
              )}
              <Button variant="ghost" className="w-full" onClick={reset}>
                {job?.status === "running" ? "abandon the read" : "new script"}
              </Button>
            </div>
          )}
        </Panel>
      </motion.aside>
    </div>
  );
}

function edit(lines: SceneLine[], set: (l: SceneLine[]) => void, i: number, patch: Partial<SceneLine>) {
  set(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
}

function DeskTab({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`font-jetbrains rounded-full border px-4 py-1.5 text-[12px] uppercase tracking-[0.14em] transition ${
        on ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-200" : "border-white/10 text-white/55 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

function NumField({ label, value, onChange }: {
  label: string; value: number; onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="font-jetbrains text-[11px] uppercase text-white/40">{label}</span>
      <input
        type="number" min={0} step={0.1} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="font-jetbrains w-20 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[13px] text-white outline-none transition focus:border-cyan-300/50"
      />
    </label>
  );
}

function Row({ k, v, warn = false }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="uppercase tracking-[0.14em] text-white/35">{k}</dt>
      <dd className={warn ? "text-amber-200" : "text-white/70"}>{v}</dd>
    </div>
  );
}
