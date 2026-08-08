"use client";

// CUTTING ROOM — the video is the spine. One central metaphor carried
// through: an editor's bench. The monitor sits on top, the film strip of
// scenes runs under it, and every measured fact (fit, spill, timecode) hangs
// off the strip like tape labels. Type is mono-heavy; the room thinks in
// timecodes.

import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Eyebrow, Panel } from "@/components/ui/Primitives";
import { rise } from "@/components/ui/tokens";
import { ApiError } from "@/lib/apiFetch";
import {
  cancelJob, frameUrl, isRevoiceFit, mediaUrl, submitRevoice, submitVoiceover,
  useStudioJob, type SceneLine, type StudioKind,
} from "./data";
import { CharacterSelect, FitMeter, StepsRail, tc, useRoster } from "./shared";

export default function CuttingRoom() {
  const { roster, rosterError } = useRoster();
  const [mode, setMode] = useState<StudioKind>("voiceover");
  const [url, setUrl] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [style, setStyle] = useState("");
  const [lines, setLines] = useState<SceneLine[]>([
    { character_id: "", text: "", start: 0, end: 5 },
  ]);
  const [jobRef, setJobRef] = useState<{ kind: StudioKind; id: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { job, stalled } = useStudioJob(jobRef?.kind ?? "voiceover", jobRef?.id ?? null);

  const canSubmit = useMemo(() => {
    if (!url.trim() || submitting) return false;
    if (mode === "voiceover") return Boolean(characterId);
    return lines.length > 0 && lines.every((l) => l.character_id && l.text.trim() && l.end > l.start);
  }, [url, submitting, mode, characterId, lines]);

  const submit = async () => {
    if (!canSubmit) return; // the in-flight gate: submitting is part of canSubmit
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
    <div className="space-y-6">
      <motion.div variants={rise} initial="hidden" animate="show">
        <Eyebrow>studio · cutting room</Eyebrow>
        <h1 className="font-instrument mt-3 text-4xl text-white">The bench</h1>
        <p className="font-hanken mt-2 max-w-2xl text-base text-slate-300">
          A video on the monitor, its scenes on the strip. Narrate silent footage, or
          re-perform known dialogue — every line shows how it fits its slot.
        </p>
      </motion.div>

      {!jobRef && (
        <motion.div variants={rise} initial="hidden" animate="show" custom={1}>
          <Panel className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <ModeTab on={mode === "voiceover"} onClick={() => setMode("voiceover")}
                       label="voiceover" sub="silent footage → narration" />
              <ModeTab on={mode === "revoice"} onClick={() => setMode("revoice")}
                       label="re-voice" sub="known dialogue → new voices" />
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-[1fr_280px]">
              <div>
                <label htmlFor="cr-url" className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                  source reel
                </label>
                <input
                  id="cr-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=…"
                  className="font-hanken mt-2 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
                />
              </div>
              {mode === "voiceover" && (
                <div>
                  <label htmlFor="cr-char" className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                    narrator
                  </label>
                  <div className="mt-2">
                    <CharacterSelect id="cr-char" roster={roster} value={characterId} onChange={setCharacterId} />
                  </div>
                </div>
              )}
            </div>

            {mode === "voiceover" ? (
              <div className="mt-4">
                <label htmlFor="cr-style" className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                  direction to the writer
                </label>
                <input
                  id="cr-style" value={style} onChange={(e) => setStyle(e.target.value)}
                  placeholder="playful nature-documentary tone…"
                  className="font-hanken mt-2 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
                />
              </div>
            ) : (
              <LineStrip roster={roster} lines={lines} setLines={setLines} />
            )}

            <div className="mt-5 flex items-center gap-3">
              <Button onClick={submit} disabled={!canSubmit}>
                {submitting ? "rolling…" : "roll"}
              </Button>
              {mode === "revoice" && (
                <span className="font-jetbrains text-[11px] text-white/45">
                  the brain composes one emotion per line and may shorten lines that cannot fit — every change is reported
                </span>
              )}
            </div>
            {rosterError && <ErrorBanner>{rosterError}</ErrorBanner>}
            {error && <ErrorBanner>{error}</ErrorBanner>}
          </Panel>
        </motion.div>
      )}

      {jobRef && job && (
        <motion.div variants={rise} initial="hidden" animate="show">
          <Panel className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                  {jobRef.kind === "voiceover" ? "narrating" : "re-voicing"}
                </p>
                <p className="font-hanken mt-1 text-lg text-white">{job.source.title ?? job.source.url}</p>
                {job.partial.video && (
                  <p className="font-jetbrains mt-1 text-[12px] text-white/45">
                    {tc(job.partial.video.seconds)} · {job.partial.video.width}×{job.partial.video.height}
                    {job.brain ? ` · brain: ${job.brain.backend}` : ""}
                  </p>
                )}
              </div>
              <Button variant="ghost" onClick={reset}>
                {job.status === "running" ? "cut & discard" : "new reel"}
              </Button>
            </div>

            {job.status === "running" && (
              <div className="mt-5"><StepsRail job={job} stalled={stalled} /></div>
            )}
            {job.status === "error" && <ErrorBanner>{job.error}</ErrorBanner>}
            {job.status === "expired" && (
              <ErrorBanner>this session aged out on the box — roll it again</ErrorBanner>
            )}

            {job.status === "done" && job.result && (
              <div className="mt-5 space-y-5">
                {/* the monitor */}
                <video
                  src={mediaUrl(jobRef.kind, jobRef.id, "video")}
                  controls
                  className="w-full rounded-xl border border-white/8 bg-black"
                />
                {/* the strip */}
                <div>
                  <p className="font-jetbrains mb-2 text-[11px] uppercase tracking-[0.18em] text-cyan-300">
                    the strip
                  </p>
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {job.result.fit.map((f, idx) => {
                      const scene = isRevoiceFit(f) ? f.i : f.scene;
                      return (
                        <div key={idx} className="w-56 shrink-0 rounded-lg border border-white/8 bg-white/[0.03] p-3">
                          {jobRef.kind === "voiceover" && (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={frameUrl(jobRef.id, scene)} alt={`scene ${scene + 1}`}
                              className="mb-2 aspect-video w-full rounded-md border border-white/8 object-cover"
                            />
                          )}
                          <p className="font-jetbrains text-[11px] text-white/45">
                            #{scene + 1}
                            {isRevoiceFit(f) ? ` · ${f.emotion ?? "baseline"}` : f.emotion ? ` · ${f.emotion}` : ""}
                          </p>
                          <p className="font-hanken mt-1 line-clamp-3 min-h-[3.5rem] text-sm text-slate-300">
                            {isRevoiceFit(f) ? (f.rewritten_text ?? "") || "—" : f.text || "(silent)"}
                          </p>
                          <div className="mt-2"><FitMeter fit={f} /></div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {job.limits.length > 0 && (
                  <ErrorBanner severity="warning" className="mt-0">
                    {job.limits.join(" · ")}
                  </ErrorBanner>
                )}
                <div className="flex gap-3">
                  <a href={mediaUrl(jobRef.kind, jobRef.id, "video")} download>
                    <Button variant="ghost">download reel</Button>
                  </a>
                  <a href={mediaUrl(jobRef.kind, jobRef.id, "track")} download>
                    <Button variant="ghost">download track</Button>
                  </a>
                </div>
              </div>
            )}
          </Panel>
        </motion.div>
      )}
    </div>
  );
}

function ModeTab({ on, onClick, label, sub }: {
  on: boolean; onClick: () => void; label: string; sub: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-lg border px-4 py-2 text-left transition ${
        on ? "border-cyan-300/40 bg-cyan-300/10" : "border-white/10 hover:border-white/25"
      }`}
    >
      <span className={`font-jetbrains block text-[12px] uppercase tracking-[0.14em] ${on ? "text-cyan-200" : "text-white/60"}`}>
        {label}
      </span>
      <span className="font-hanken text-sm text-white/45">{sub}</span>
    </button>
  );
}

/** Pre-submit line editor drawn as strip cells — the same film-strip the
 *  result renders, so the mental model survives the submit. */
function LineStrip({ roster, lines, setLines }: {
  roster: ReturnType<typeof useRoster>["roster"];
  lines: SceneLine[];
  setLines: (l: SceneLine[]) => void;
}) {
  const edit = (i: number, patch: Partial<SceneLine>) =>
    setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <div className="mt-4">
      <p className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
        the lines · absolute timecodes from the scan
      </p>
      <div className="mt-2 flex gap-3 overflow-x-auto pb-2">
        {lines.map((l, i) => (
          <div key={i} className="w-64 shrink-0 rounded-lg border border-white/8 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between">
              <span className="font-jetbrains text-[11px] text-white/45">#{i + 1}</span>
              <button
                onClick={() => setLines(lines.filter((_, k) => k !== i))}
                className="font-jetbrains text-[11px] text-white/40 transition hover:text-rose-300"
                aria-label={`remove line ${i + 1}`}
              >
                ✕
              </button>
            </div>
            <div className="mt-2">
              <CharacterSelect roster={roster} value={l.character_id}
                               onChange={(id) => edit(i, { character_id: id })} />
            </div>
            <textarea
              value={l.text} onChange={(e) => edit(i, { text: e.target.value })}
              placeholder="what gets said…" rows={3}
              className="font-hanken mt-2 w-full resize-none rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-base text-white outline-none transition focus:border-cyan-300/50"
            />
            <div className="mt-2 flex items-center gap-2">
              <TimeField label="in" value={l.start} onChange={(v) => edit(i, { start: v })} />
              <span className="text-white/30">→</span>
              <TimeField label="out" value={l.end} onChange={(v) => edit(i, { end: v })} />
            </div>
          </div>
        ))}
        <button
          onClick={() => setLines([...lines, {
            character_id: lines[lines.length - 1]?.character_id ?? "",
            text: "",
            start: lines[lines.length - 1]?.end ?? 0,
            end: (lines[lines.length - 1]?.end ?? 0) + 5,
          }])}
          className="font-jetbrains w-24 shrink-0 rounded-lg border border-dashed border-white/15 text-[12px] uppercase tracking-[0.14em] text-white/45 transition hover:border-cyan-300/40 hover:text-cyan-200"
        >
          + line
        </button>
      </div>
    </div>
  );
}

function TimeField({ label, value, onChange }: {
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
