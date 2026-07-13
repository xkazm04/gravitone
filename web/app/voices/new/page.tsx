"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import AppFrame from "@/components/ui/AppFrame";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import EmotionArt from "@/components/ui/EmotionArt";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import { useAuth } from "@/lib/useAuth";
import { recordVoiceOwnership } from "@/lib/voiceVault";
import WaveformLab from "./_loaders/WaveformLab";
import type { LoaderData } from "./_loaders/shared";
import {
  reducer, initialState, POLLING_PHASES,
  type Character, type Job,
} from "./_state/machine";
import { useIngestJob } from "./_state/useIngestJob";

// Kept in sync with the attestation label rendered in the review step; sent to
// the backend so the consent receipt records exactly what the user agreed to.
const CONSENT_STATEMENT =
  "I own this voice or have the speaker's explicit consent to clone it.";

export default function NewCharacterPage() {
  const { user } = useAuth();

  // The whole create-flow state graph in one reducer.
  const [state, dispatch] = useReducer(reducer, initialState);
  const { phase, jobId, job, result, selected, error,
    mode, charName, extendCid, committedCid, created } = state;

  // Ephemeral input/UI state — not part of the flow's state graph.
  const [consented, setConsented] = useState(false); // Voice Vault attestation
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  // auto = cloud quality when the backend has API keys, else local.
  // sovereign = force local-only: the recording never leaves the machine.
  const [ingestMode, setIngestMode] = useState<"auto" | "sovereign">("auto");
  const [characters, setCharacters] = useState<Character[]>([]);

  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/characters", { cache: "no-store" }).then((r) => (r.ok ? r.json() : []))
      .then((cs: (Character & { category: string })[]) => setCharacters(cs.filter((c) => c.category === "cloned")))
      .catch(() => {});
  }, [phase]);

  // ONE poller for both the analyze leg and the commit leg.
  useIngestJob({
    jobId,
    enabled: POLLING_PHASES.has(phase),
    onJob: (j: Job) => dispatch({ type: "JOB_POLLED", job: j }),
    onExpired: () => dispatch({ type: "JOB_EXPIRED" }),
  });

  // Record Voice Vault ownership exactly once, when the commit completes.
  const recorded = useRef(false);
  useEffect(() => {
    if (phase === "upload") { recorded.current = false; return; }
    if (phase !== "complete" || recorded.current) return;
    recorded.current = true;
    const pending = state.pendingCommit;
    if (user && pending && created.length) {
      void recordVoiceOwnership(user, created.map((v) => ({
        voice_id: v.voice_id, character_id: pending.cid,
        character_name: pending.character, emotion: v.emotion,
      })), "ingested");
    }
  }, [phase, user, created, state.pendingCommit]);

  // Validate before we accept a file — no upload round-trip for a bad pick.
  async function acceptFile(f: File | undefined | null) {
    if (!f) return;
    const err = await validateUpload(f);
    if (err) { setFile(null); dispatch({ type: "SET_ERROR", error: err }); return; }
    setFile(f); dispatch({ type: "SET_ERROR", error: null });
  }

  async function startScan() {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("mode", ingestMode);
    try {
      const r = await fetch("/api/ingest/scan", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.detail ?? "scan failed to start");
      dispatch({ type: "SCAN_STARTED", jobId: j.job_id });
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: e instanceof Error ? e.message : "scan failed" });
    }
  }

  async function chooseSpeaker(sid: string) {
    audioRef.current?.pause(); setPlaying(null);
    await fetch(`/api/ingest/${jobId}/speaker`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speaker_id: sid }) });
    dispatch({ type: "SPEAKER_CHOSEN" });
  }

  function playClip(url: string, id: string) {
    if (playing === id) { audioRef.current?.pause(); setPlaying(null); return; }
    audioRef.current?.pause();
    const a = audioRef.current ?? (audioRef.current = new Audio());
    a.src = url; a.onended = () => setPlaying(null);
    void a.play(); setPlaying(id);
  }

  async function commit() {
    if (selected.size === 0) return;
    const character = mode === "new" ? charName.trim() : (characters.find((c) => c.character_id === extendCid)?.name ?? "");
    const character_id = mode === "extend" ? extendCid : undefined;
    if (mode === "new" && !character) { dispatch({ type: "SET_ERROR", error: "Name the character" }); return; }
    if (mode === "extend" && !extendCid) { dispatch({ type: "SET_ERROR", error: "Pick a character to extend" }); return; }
    const cid = character_id ?? slug(character);
    dispatch({ type: "COMMIT_STARTED", character, cid, total: selected.size });
    try {
      // async commit: the backend returns immediately; the poller follows
      // per-emotion progress through to 'committed' / 'error'.
      const r = await fetch(`/api/ingest/${jobId}/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ character, emotions: [...selected], character_id, attested: consented, statement: CONSENT_STATEMENT }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.detail ?? "commit failed");
    } catch (e) {
      dispatch({ type: "COMMIT_FAILED", error: e instanceof Error ? e.message : "commit failed" });
    }
  }

  async function cancelCommit() {
    // DELETE tears down the whole job server-side (workdir included), so the
    // review ledger is gone too — the only honest place to land is upload.
    try { await fetch(`/api/ingest/${jobId}`, { method: "DELETE" }); } catch { /* ignore */ }
    startOver();
  }

  function startOver() {
    setFile(null);
    dispatch({ type: "RESET", kind: "start-over" });
  }

  function scanAnother() {
    setFile(null);
    dispatch({ type: "RESET", kind: "scan-another" });
  }

  const loaderData: LoaderData = { steps: job?.steps ?? [], partial: job?.partial ?? {}, duration: job?.duration };

  return (
    <AppFrame>
      <div className="py-10">
        <Link href="/voices" className="font-jetbrains text-[12px] text-white/45 transition hover:text-white">← characters</Link>
        <Eyebrow>new character</Eyebrow>
        <h1 className="font-instrument mt-3 text-4xl text-white">Build from a recording.</h1>
        <p className="mt-2 max-w-2xl text-base text-white/70">
          Drop a recording — we transcribe &amp; diarize it, you pick the speaker, we isolate them,
          detect emotions, and propose a set of emotion Voices to assign into a Character.
        </p>

        {error && <p className="font-jetbrains mt-4 rounded-lg border border-rose-400/25 bg-rose-400/5 px-4 py-2 text-[12px] text-rose-200">{error}</p>}

        {/* UPLOAD */}
        {phase === "upload" && (
          <div className="mt-8 max-w-2xl">
            <div
              role="button" tabIndex={0} aria-label="Choose or drop an audio recording"
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); void acceptFile(e.dataTransfer.files?.[0]); }}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
              className={`grid cursor-pointer place-items-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition focus:outline-none focus-visible:border-cyan-400/60 focus-visible:bg-cyan-400/5 ${dragging ? "border-cyan-400/60 bg-cyan-400/5" : "border-white/12 hover:border-white/30"}`}
            >
              <input ref={fileRef} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => { void acceptFile(e.target.files?.[0]); }} />
              <div>
                <div className="text-lg text-white">{file ? file.name : "Drop an mp3 / recording, or click to choose"}</div>
                <div className="font-jetbrains mt-1 text-[12px] text-white/55">
                  {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "a minute+ of speech with emotional range works best"}
                </div>
              </div>
            </div>
            {committedCid && <p className="font-jetbrains mt-3 text-[12px] text-cyan-300/80">Extending an existing character with more emotions.</p>}

            {/* privacy mode */}
            <div className="glass-panel mt-4 rounded-2xl p-4">
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setIngestMode("auto")} aria-pressed={ingestMode === "auto"}
                  className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] transition ${ingestMode === "auto" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"}`}>
                  Cloud quality
                </button>
                <button onClick={() => setIngestMode("sovereign")} aria-pressed={ingestMode === "sovereign"}
                  className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] transition ${ingestMode === "sovereign" ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-white/12 text-white/60 hover:text-white"}`}>
                  🔒 Sovereign — audio never leaves this machine
                </button>
              </div>
              <p className="font-jetbrains mt-2 text-[11px] leading-relaxed text-white/50">
                {ingestMode === "sovereign"
                  ? "Local ffmpeg pipeline only: cleanup + speech detection on this box, no transcription, no third-party APIs. Emotions are recorded afterwards with the guided per-emotion capture."
                  : "Uses ElevenLabs (diarize + isolate) and Gemini (emotion labels) when the backend has keys; falls back to local processing when it doesn't."}
              </p>
            </div>

            <Button onClick={startScan} disabled={!file} className="mt-5 cursor-pointer">Scan recording →</Button>
          </div>
        )}

        {/* PROCESSING — Waveform Lab won the loader round */}
        {phase === "processing" && (
          <div className="mt-10 max-w-3xl">
            {job?.mode === "sovereign" && (
              <p className="font-jetbrains mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/5 px-3 py-1 text-[11px] text-emerald-200">
                🔒 sovereign mode — processing locally, audio stays on this machine
              </p>
            )}
            <WaveformLab data={loaderData} />
          </div>
        )}

        {/* SPEAKER PICK */}
        {phase === "speaker" && job?.speakers && (
          <div className="mt-8 max-w-3xl">
            <h2 className="font-instrument text-2xl text-white">Which voice is your character?</h2>
            <p className="mt-1 text-sm text-white/60">{job.speakers.length} speakers detected. Play a sample, then pick the one to build from.</p>
            <div className="mt-5 space-y-2">
              {job.speakers.map((s, i) => (
                <div key={s.id} className="glass-panel flex items-center gap-3 rounded-xl px-4 py-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-slate-950" style={{ background: `hsl(${(i * 67) % 360} 85% 65%)` }}>{i + 1}</span>
                  <button onClick={() => playClip(`/api/ingest/${jobId}/speaker-preview/${s.id}`, s.id)} aria-label="Play sample"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110">
                    {playing === s.id ? "⏸" : "▶"}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="font-jetbrains text-[12px] text-white/80">{s.id} · <span className="text-white">{s.seconds}s</span> · {s.utterances} utterances</div>
                    <div className="line-clamp-1 text-sm italic text-white/50">“{s.sample_text}”</div>
                  </div>
                  <Button onClick={() => chooseSpeaker(s.id)} className="shrink-0 cursor-pointer px-4 py-2 text-[13px]">Use this →</Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* REVIEW — ledger */}
        {phase === "review" && result && (
          <div className="mt-8">
            <div className="font-jetbrains flex flex-wrap gap-4 text-[12px] text-white/60">
              <span>{result.duration}s audio</span>
              <span>{result.speakers.length} speakers · target <span className="text-white">{result.target}</span></span>
              <span>{result.utterances} utterances</span>
            </div>
            {(job?.partial?.label_errors ?? 0) > 0 && (
              <p className="font-jetbrains mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[12px] text-amber-200/85">
                {job!.partial!.label_errors} segment{job!.partial!.label_errors === 1 ? "" : "s"} couldn’t be classified — they fell back to the baseline stem.
              </p>
            )}

            <div className="mt-6 flex items-end justify-between">
              <div>
                <h2 className="font-instrument text-2xl text-white">Proposed voices</h2>
                <p className="mt-1 text-sm text-white/60">Keep or descope each emotion. “Short” stems are below the clone threshold.</p>
              </div>
              <span className="font-jetbrains text-[12px] text-white/60">{selected.size} selected</span>
            </div>

            <div className="glass-panel mt-4 overflow-x-auto rounded-xl">
              <table className="w-full min-w-[680px] border-collapse text-sm">
                <thead className="border-b border-white/8">
                  <tr className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
                    <th className="w-12 px-3 py-2" />
                    <th className="px-3 py-2 text-left font-normal">emotion</th>
                    <th className="px-3 py-2 text-left font-normal">length</th>
                    <th className="px-3 py-2 text-left font-normal">segments</th>
                    <th className="px-3 py-2 text-left font-normal">vocal cue</th>
                    <th className="w-24 px-3 py-2" />
                    <th className="w-28 px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {result.stems.map((st) => {
                    const on = selected.has(st.emotion);
                    const m = emotionMeta(st.emotion);
                    return (
                      <tr key={st.emotion} className={`border-b border-white/5 transition hover:bg-white/[0.03] ${on ? "" : "opacity-55"}`}>
                        <td className="px-3 py-2">
                          <span className="grid h-9 w-9 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
                            <EmotionArt emotion={st.emotion} size={30} dim={!on} />
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2 text-sm font-medium text-white">
                            <span className="h-2 w-2 rounded-full" style={{ background: `hsl(${m.hue} 85% 62%)` }} />{m.label}
                            {!st.eligible && <span className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">short</span>}
                          </span>
                        </td>
                        <td className="font-jetbrains px-3 py-2 text-[12px] text-white/70">{st.seconds}s</td>
                        <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{st.segments}</td>
                        <td className="px-3 py-2 text-[12px] italic text-white/50">{st.cues[0] ? `“${st.cues[0]}”` : "—"}</td>
                        <td className="px-3 py-2">
                          <button onClick={() => playClip(`/api/ingest/${jobId}/preview/${st.emotion}`, `stem-${st.emotion}`)}
                            aria-label={`${playing === `stem-${st.emotion}` ? "Pause" : "Play"} ${m.label} stem`}
                            className="grid h-8 w-8 place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110">
                            {playing === `stem-${st.emotion}` ? "⏸" : "▶"}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button onClick={() => dispatch({ type: "TOGGLE_EMOTION", emotion: st.emotion })} aria-pressed={on}
                            className={`font-jetbrains rounded-lg border px-2.5 py-1 text-[11px] transition ${on ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/55 hover:text-white"}`}>
                            {on ? "✓ keep" : "descope"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="glass-panel mt-6 max-w-2xl rounded-2xl p-5">
              <div className="flex gap-2">
                <button onClick={() => dispatch({ type: "SET_MODE", mode: "new" })} className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] ${mode === "new" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60"}`}>New character</button>
                <button onClick={() => dispatch({ type: "SET_MODE", mode: "extend" })} disabled={characters.length === 0} className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] disabled:opacity-40 ${mode === "extend" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60"}`}>Extend existing</button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {mode === "new" ? (
                  <input value={charName} onChange={(e) => dispatch({ type: "SET_CHAR_NAME", name: e.target.value })} placeholder="Character name"
                    className="font-hanken w-56 rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
                ) : (
                  <select value={extendCid} onChange={(e) => dispatch({ type: "SET_EXTEND_CID", cid: e.target.value })}
                    className="font-jetbrains rounded-xl border border-white/12 bg-[#0d1017] px-3 py-2.5 text-[13px] text-white/85 focus:outline-none">
                    <option value="">choose character…</option>
                    {characters.map((c) => <option key={c.character_id} value={c.character_id}>{c.name}</option>)}
                  </select>
                )}
                <Button onClick={commit} disabled={selected.size === 0 || !consented} className="ml-auto cursor-pointer">
                  {mode === "new" ? "Create character" : "Add to character"} ({selected.size})
                </Button>
              </div>
              <label className="mt-4 flex cursor-pointer items-start gap-2 text-[13px] text-white/70">
                <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)}
                  className="mt-0.5 accent-cyan-300" />
                <span>
                  I own this voice or have the speaker&apos;s explicit consent to clone it.{" "}
                  <span className="font-jetbrains text-[11px] text-white/45">
                    (attestation stored with the voices — Voice Vault)
                  </span>
                </span>
              </label>
            </div>
          </div>
        )}

        {/* COMMITTING — real per-emotion progress from the async commit */}
        {phase === "committing" && (() => {
          const total = job?.partial?.emotions_total ?? selected.size;
          const done = job?.partial?.emotions_done ?? 0;
          const current = job?.partial?.current ?? null;
          const pct = total ? Math.round((done / total) * 100) : 0;
          return (
            <div className="mt-16 text-center">
              <div className="font-jetbrains text-[12px] uppercase tracking-widest text-cyan-300">
                cloning voices · {done}/{total}
              </div>
              <p className="mt-2 text-sm text-white/60">
                {current ? <>Cloning <span className="text-white">{emotionMeta(current).label}</span> on the CPU engine…</> : "Cloning on the CPU engine…"}
              </p>
              <div className="mx-auto mt-5 h-1.5 w-64 overflow-hidden rounded-full bg-white/10"
                role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
                aria-label={`Cloning voices, ${done} of ${total} done`}>
                <div className="h-full rounded-full bg-cyan-300 transition-all duration-500" style={{ width: `${pct}%` }} />
              </div>
              <button onClick={cancelCommit}
                className="font-jetbrains mt-6 cursor-pointer rounded-full border border-white/15 px-5 py-2 text-[13px] text-white/70 transition hover:bg-white/5">
                Cancel
              </button>
            </div>
          );
        })()}

        {/* EXPIRED — the job aged out (or was cancelled); poller stopped */}
        {phase === "expired" && (
          <div className="mt-10 max-w-2xl">
            <div className="glass-panel rounded-2xl p-6">
              <div className="font-jetbrains text-[11px] uppercase tracking-widest text-amber-300">session expired</div>
              <h2 className="font-instrument mt-2 text-3xl text-white">This ingest session ended.</h2>
              <p className="mt-2 text-sm text-white/60">
                Scan sessions are held for a limited time and then cleaned up. Nothing was saved — start over with your recording.
              </p>
              <button onClick={startOver}
                className="mt-6 cursor-pointer rounded-full bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110">
                Start over
              </button>
            </div>
          </div>
        )}

        {/* COMPLETE */}
        {phase === "complete" && (
          <div className="mt-10 max-w-2xl">
            <div className="glass-panel rounded-2xl p-6">
              <div className="font-jetbrains text-[11px] uppercase tracking-widest text-emerald-300">character ready</div>
              <h2 className="font-instrument mt-2 text-3xl text-white">{created.length} voices cloned.</h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {created.map((c) => {
                  const m = emotionMeta(c.emotion);
                  return (
                    <span key={c.voice_id} className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] text-white/80">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${m.hue} 80% 62%)` }} />{m.label}
                    </span>
                  );
                })}
              </div>
              {/* Coverage Coach — the recording produced an incomplete rack;
                  give every remaining slot a direct path to done. Stems that
                  were detected but too short to clone are called out. */}
              {committedCid && (() => {
                const done = new Set(created.map((c) => c.emotion));
                const missing = EMOTION_IDS.filter((e) => !done.has(e));
                if (missing.length === 0) return null;
                const shortStems = new Set(
                  (result?.stems ?? []).filter((s) => !s.eligible).map((s) => s.emotion),
                );
                return (
                  <div className="mt-6 rounded-2xl border border-amber-400/15 bg-amber-400/[0.04] p-4">
                    <div className="font-jetbrains text-[11px] uppercase tracking-widest text-amber-200/80">
                      coverage coach · {done.size}/{EMOTION_IDS.length} recorded
                    </div>
                    <p className="mt-1 text-sm text-white/65">
                      Finish the rack with a guided 30-second read per emotion — no new recording to hunt for:
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {missing.map((e) => (
                        <Link
                          key={e}
                          href={`/voices/${committedCid}?record=${e}`}
                          className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-black/30 px-2.5 py-1 text-[11px] text-amber-200/90 transition hover:border-amber-300/50 hover:text-amber-100"
                        >
                          ● {emotionMeta(e).label}
                          {shortStems.has(e) && <span className="text-white/45">(detected, too short)</span>}
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div className="mt-6 flex flex-wrap gap-3">
                {committedCid && <Link href={`/voices/${committedCid}`} className="rounded-full bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110">Open character →</Link>}
                <button onClick={scanAnother} className="font-jetbrains cursor-pointer rounded-full border border-white/15 px-5 py-2.5 text-sm text-white/85 transition hover:bg-white/5">Scan another recording (extend palette)</button>
                <Link href="/voices" className="font-jetbrains rounded-full px-5 py-2.5 text-sm text-white/60 transition hover:text-white">Back to roster</Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppFrame>
  );
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";
}

// ── client-side upload pre-check ──────────────────────────────────────────────
// Mirrors the backend gate (service/ingest_api.py) so a bad file is caught
// before it uploads instead of after a full round-trip + 400.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB — matches MAX_UPLOAD_BYTES
const MIN_CLIP_SECONDS = 3;                // matches MIN_CLIP_SECONDS
// Full backend extension whitelist (_AUDIO_EXTS).
const ACCEPTED_EXTS = [
  ".mp3", ".wav", ".wave", ".m4a", ".m4b", ".mp4", ".mov", ".ogg", ".oga",
  ".opus", ".flac", ".aac", ".webm", ".wma", ".aiff", ".aif", ".aifc",
  ".amr", ".3gp", ".mkv",
];
// Picker accept: broad mime families + every accepted extension.
const ACCEPT_ATTR = ["audio/*", "video/*", ...ACCEPTED_EXTS].join(",");

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

// Probe duration by loading metadata into a throwaway <audio> element.
// Resolves null when the browser can't determine it (backend re-probes).
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("audio");
    a.preload = "metadata";
    let settled = false;
    const finish = (v: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(t); URL.revokeObjectURL(url); a.removeAttribute("src"); resolve(v);
    };
    // Some containers the backend accepts (mkv/amr/…) may never fire an event
    // in the browser — never block the picker: fall back to "unknown" (null),
    // and let the server re-probe.
    const t = setTimeout(() => finish(null), 4000);
    a.onloadedmetadata = () => finish(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => finish(null);
    a.src = url;
  });
}

async function validateUpload(file: File): Promise<string | null> {
  if (file.size === 0) return "empty file — choose an audio recording";
  if (file.size > MAX_UPLOAD_BYTES) return `file too large — keep it under ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`;
  const mimeOk = /^(audio|video)\//.test(file.type);
  if (!ACCEPTED_EXTS.includes(extOf(file.name)) && !mimeOk) {
    return "unsupported file type — upload an audio or video recording";
  }
  const dur = await probeDuration(file);
  if (dur !== null && dur < MIN_CLIP_SECONDS) {
    return `clip too short — record at least ${MIN_CLIP_SECONDS} seconds of speech`;
  }
  return null;
}
