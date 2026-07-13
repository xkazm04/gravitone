"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppFrame from "@/components/ui/AppFrame";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import EmotionArt from "@/components/ui/EmotionArt";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import { useAuth } from "@/lib/useAuth";
import { recordVoiceOwnership } from "@/lib/voiceVault";
import WaveformLab from "./_loaders/WaveformLab";
import type { LoaderData, LoaderStep, Partial as PartialData } from "./_loaders/shared";

type Speaker = { id: string; utterances: number; seconds: number; sample_text: string };
type Stem = { emotion: string; seconds: number; segments: number; eligible: boolean; cues: string[] };
type Result = { duration: number; speakers: string[]; target: string; utterances: number; stems: Stem[] };
type Character = { character_id: string; name: string };
type Created = { voice_id: string; emotion: string };
type Job = { status: string; step: string | null; steps: LoaderStep[]; partial: PartialData;
  speakers: Speaker[] | null; duration: number; result: Result | null; error: string | null;
  mode?: "cloud" | "sovereign"; committed?: Created[] | null };

type Phase = "upload" | "processing" | "speaker" | "review" | "committing" | "complete" | "expired";

// Kept in sync with the attestation label rendered in the review step; sent to
// the backend so the consent receipt records exactly what the user agreed to.
const CONSENT_STATEMENT =
  "I own this voice or have the speaker's explicit consent to clone it.";

export default function NewCharacterPage() {
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>("upload");
  const [consented, setConsented] = useState(false); // Voice Vault attestation
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<"new" | "extend">("new");
  // auto = cloud quality when the backend has API keys, else local.
  // sovereign = force local-only: the recording never leaves the machine.
  const [ingestMode, setIngestMode] = useState<"auto" | "sovereign">("auto");
  const [charName, setCharName] = useState("");
  const [extendCid, setExtendCid] = useState("");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [created, setCreated] = useState<Created[]>([]);
  const [committedCid, setCommittedCid] = useState<string | null>(null);
  const [pendingCommit, setPendingCommit] = useState<{ character: string; cid: string } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/characters", { cache: "no-store" }).then((r) => (r.ok ? r.json() : []))
      .then((cs: (Character & { category: string })[]) => setCharacters(cs.filter((c) => c.category === "cloned")))
      .catch(() => {});
  }, [phase]);

  // poll the job while processing or awaiting a speaker
  useEffect(() => {
    if (!jobId || !(phase === "processing" || phase === "speaker")) return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`/api/ingest/${jobId}`, { cache: "no-store" });
        if (r.status === 404) { setPhase("expired"); clearInterval(iv); return; }
        const j: Job = await r.json();
        if (j.status === "expired") { setPhase("expired"); clearInterval(iv); return; }
        setJob(j);
        if (j.status === "awaiting_speaker") setPhase("speaker");
        else if (j.status === "running") setPhase("processing");
        else if (j.status === "done" && j.result) { setResult(j.result); setSelected(new Set(j.result.stems.filter((s) => s.eligible).map((s) => s.emotion))); setPhase("review"); clearInterval(iv); }
        else if (j.status === "error") { setError(j.error ?? "failed"); setPhase("upload"); clearInterval(iv); }
      } catch { /* keep polling */ }
    }, 1500);
    return () => clearInterval(iv);
  }, [jobId, phase]);

  // poll the async commit — real per-emotion progress, terminal states
  useEffect(() => {
    if (!jobId || phase !== "committing") return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`/api/ingest/${jobId}`, { cache: "no-store" });
        if (r.status === 404) { setPhase("expired"); clearInterval(iv); return; }
        const j: Job = await r.json();
        setJob(j);
        if (j.status === "committed") {
          const madeVoices = j.committed ?? [];
          const cid = pendingCommit?.cid ?? committedCid;
          if (user && pendingCommit && Array.isArray(madeVoices)) {
            void recordVoiceOwnership(user, madeVoices.map((v) => ({
              voice_id: v.voice_id, character_id: pendingCommit.cid,
              character_name: pendingCommit.character, emotion: v.emotion,
            })), "ingested");
          }
          setCreated(madeVoices); setCommittedCid(cid ?? null); setPhase("complete"); clearInterval(iv);
        } else if (j.status === "error") { setError(j.error ?? "commit failed"); setPhase("review"); clearInterval(iv); }
        else if (j.status === "cancelled" || j.status === "expired") { setPhase("expired"); clearInterval(iv); }
      } catch { /* keep polling */ }
    }, 1200);
    return () => clearInterval(iv);
  }, [jobId, phase, user, pendingCommit, committedCid]);

  async function startScan() {
    if (!file) return;
    setError(null);
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("mode", ingestMode);
    try {
      const r = await fetch("/api/ingest/scan", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.detail ?? "scan failed to start");
      setJobId(j.job_id);
      setJob({ status: "running", step: "transcribe", steps: [
        { key: "transcribe", label: "Transcribe & diarize", state: "active" },
        { key: "isolate", label: "Isolate voice", state: "pending" },
        { key: "label", label: "Detect emotions", state: "pending" },
        { key: "stem", label: "Build emotion stems", state: "pending" }],
        partial: {}, speakers: null, duration: 0, result: null, error: null });
      setPhase("processing");
    } catch (e) { setError(e instanceof Error ? e.message : "scan failed"); }
  }

  async function chooseSpeaker(sid: string) {
    audioRef.current?.pause(); setPlaying(null);
    await fetch(`/api/ingest/${jobId}/speaker`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speaker_id: sid }) });
    setPhase("processing");
  }

  function playClip(url: string, id: string) {
    if (playing === id) { audioRef.current?.pause(); setPlaying(null); return; }
    audioRef.current?.pause();
    const a = audioRef.current ?? (audioRef.current = new Audio());
    a.src = url; a.onended = () => setPlaying(null);
    void a.play(); setPlaying(id);
  }

  function toggle(emotion: string) {
    setSelected((s) => { const n = new Set(s); n.has(emotion) ? n.delete(emotion) : n.add(emotion); return n; });
  }

  async function commit() {
    if (selected.size === 0) return;
    const character = mode === "new" ? charName.trim() : (characters.find((c) => c.character_id === extendCid)?.name ?? "");
    const character_id = mode === "extend" ? extendCid : undefined;
    if (mode === "new" && !character) { setError("Name the character"); return; }
    if (mode === "extend" && !extendCid) { setError("Pick a character to extend"); return; }
    const cid = character_id ?? slug(character);
    setPendingCommit({ character, cid });
    setJob((j) => j ? { ...j, status: "committing", partial: { emotions_done: 0, emotions_total: selected.size, current: null } } : j);
    setPhase("committing"); setError(null);
    try {
      // async commit: the backend returns immediately; the committing poller
      // follows per-emotion progress through to 'committed' / 'error'.
      const r = await fetch(`/api/ingest/${jobId}/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ character, emotions: [...selected], character_id }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.detail ?? "commit failed");
    } catch (e) { setError(e instanceof Error ? e.message : "commit failed"); setPhase("review"); }
  }

  async function cancelCommit() {
    try { await fetch(`/api/ingest/${jobId}`, { method: "DELETE" }); } catch { /* ignore */ }
    setPendingCommit(null); setPhase("review");
  }

  function startOver() {
    setFile(null); setResult(null); setJobId(null); setJob(null); setCreated([]);
    setSelected(new Set()); setError(null); setPendingCommit(null); setPhase("upload");
  }

  function scanAnother() {
    setMode("extend"); setExtendCid(committedCid ?? extendCid);
    setFile(null); setResult(null); setJobId(null); setJob(null); setCreated([]); setPhase("upload");
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
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) { setFile(f); setError(null); } }}
              onClick={() => fileRef.current?.click()}
              className={`grid cursor-pointer place-items-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition ${dragging ? "border-cyan-400/60 bg-cyan-400/5" : "border-white/12 hover:border-white/30"}`}
            >
              <input ref={fileRef} type="file" accept="audio/*,video/mp4" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setError(null); } }} />
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
                            className="grid h-8 w-8 place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110">
                            {playing === `stem-${st.emotion}` ? "⏸" : "▶"}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button onClick={() => toggle(st.emotion)} aria-pressed={on}
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
                <button onClick={() => setMode("new")} className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] ${mode === "new" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60"}`}>New character</button>
                <button onClick={() => setMode("extend")} disabled={characters.length === 0} className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] disabled:opacity-40 ${mode === "extend" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60"}`}>Extend existing</button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {mode === "new" ? (
                  <input value={charName} onChange={(e) => setCharName(e.target.value)} placeholder="Character name"
                    className="font-hanken w-56 rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
                ) : (
                  <select value={extendCid} onChange={(e) => setExtendCid(e.target.value)}
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
              <div className="mx-auto mt-5 h-1.5 w-64 overflow-hidden rounded-full bg-white/10">
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
