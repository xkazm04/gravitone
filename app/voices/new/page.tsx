"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppFrame from "@/components/ui/AppFrame";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import EmotionArt from "@/components/ui/EmotionArt";
import { emotionMeta } from "@/lib/emotions";
import StepProgress, { type Step } from "./_components/StepProgress";

type Stem = { emotion: string; seconds: number; segments: number; eligible: boolean; cues: string[] };
type ScanResult = { duration: number; speakers: string[]; target: string; utterances: number; min_stem: number; stems: Stem[] };
type Character = { character_id: string; name: string };

type Phase = "upload" | "scanning" | "review" | "committing" | "done";

export default function NewCharacterPage() {
  const [phase, setPhase] = useState<Phase>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // assignment
  const [mode, setMode] = useState<"new" | "extend">("new");
  const [charName, setCharName] = useState("");
  const [extendCid, setExtendCid] = useState("");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [created, setCreated] = useState<{ voice_id: string; emotion: string }[]>([]);
  const [committedCid, setCommittedCid] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/characters", { cache: "no-store" }).then((r) => (r.ok ? r.json() : []))
      .then((cs: (Character & { category: string })[]) => setCharacters(cs.filter((c) => c.category === "cloned")))
      .catch(() => {});
  }, [phase]);

  // poll the scan job
  useEffect(() => {
    if (phase !== "scanning" || !jobId) return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`/api/ingest/${jobId}`, { cache: "no-store" });
        const j = await r.json();
        setSteps(j.steps ?? []);
        if (j.status === "done") {
          clearInterval(iv);
          setResult(j.result);
          setSelected(new Set((j.result.stems as Stem[]).filter((s) => s.eligible).map((s) => s.emotion)));
          setPhase("review");
        } else if (j.status === "error") {
          clearInterval(iv); setError(j.error ?? "scan failed"); setPhase("upload");
        }
      } catch { /* keep polling */ }
    }, 1800);
    return () => clearInterval(iv);
  }, [phase, jobId]);

  function pickFile(f: File) { setFile(f); setError(null); }

  async function startScan() {
    if (!file) return;
    setError(null);
    const fd = new FormData();
    fd.append("file", file, file.name);
    try {
      const r = await fetch("/api/ingest/scan", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.detail ?? "scan failed to start");
      setJobId(j.job_id);
      setSteps([
        { key: "transcribe", label: "Transcribe & diarize", state: "active" },
        { key: "isolate", label: "Isolate voice", state: "pending" },
        { key: "label", label: "Detect emotions", state: "pending" },
        { key: "stem", label: "Build emotion stems", state: "pending" },
      ]);
      setPhase("scanning");
    } catch (e) { setError(e instanceof Error ? e.message : "scan failed"); }
  }

  function preview(emotion: string) {
    if (!jobId) return;
    if (playing === emotion) { audioRef.current?.pause(); setPlaying(null); return; }
    audioRef.current?.pause();
    const a = audioRef.current ?? (audioRef.current = new Audio());
    a.src = `/api/ingest/${jobId}/preview/${emotion}`;
    a.onended = () => setPlaying(null);
    void a.play(); setPlaying(emotion);
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
    setPhase("committing"); setError(null);
    try {
      const r = await fetch(`/api/ingest/${jobId}/commit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character, emotions: [...selected], character_id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.detail ?? "commit failed");
      setCreated(j.created ?? []);
      setCommittedCid(character_id ?? slug(character));
      setPhase("done");
    } catch (e) { setError(e instanceof Error ? e.message : "commit failed"); setPhase("review"); }
  }

  function scanAnother() {
    // keep extending the just-created character
    setMode("extend"); setExtendCid(committedCid ?? extendCid);
    setFile(null); setResult(null); setJobId(null); setSteps([]); setCreated([]); setPhase("upload");
  }

  return (
    <AppFrame>
      <div className="py-10">
        <Link href="/voices" className="font-jetbrains text-[12px] text-white/45 transition hover:text-white">← characters</Link>
        <Eyebrow>new character</Eyebrow>
        <h1 className="font-instrument mt-3 text-4xl text-white">Build from a recording.</h1>
        <p className="mt-2 max-w-2xl text-base text-white/70">
          Drop a recording — we transcribe &amp; diarize it, isolate one speaker, detect emotions,
          and propose a set of emotion Voices you assign into a Character.
        </p>

        {error && <p className="font-jetbrains mt-4 rounded-lg border border-rose-400/25 bg-rose-400/5 px-4 py-2 text-[12px] text-rose-200">{error}</p>}

        {/* UPLOAD */}
        {phase === "upload" && (
          <div className="mt-8 max-w-2xl">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) pickFile(f); }}
              onClick={() => fileRef.current?.click()}
              className={`grid cursor-pointer place-items-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition ${dragging ? "border-cyan-400/60 bg-cyan-400/5" : "border-white/12 hover:border-white/30"}`}
            >
              <input ref={fileRef} type="file" accept="audio/*,video/mp4" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); }} />
              <div>
                <div className="text-lg text-white">{file ? file.name : "Drop an mp3 / recording, or click to choose"}</div>
                <div className="font-jetbrains mt-1 text-[12px] text-white/55">
                  {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "a minute+ of one person speaking, with emotional range, works best"}
                </div>
              </div>
            </div>
            {committedCid && (
              <p className="font-jetbrains mt-3 text-[12px] text-cyan-300/80">Extending an existing character with more emotions.</p>
            )}
            <Button onClick={startScan} disabled={!file} className="mt-5 cursor-pointer">Scan recording →</Button>
          </div>
        )}

        {/* SCANNING */}
        {phase === "scanning" && (
          <div className="mt-12 max-w-3xl">
            <StepProgress steps={steps} />
            <p className="font-jetbrains mt-8 text-center text-[12px] text-white/55">Analysing… this takes a minute for a short clip.</p>
          </div>
        )}

        {/* REVIEW */}
        {phase === "review" && result && (
          <div className="mt-8">
            <StepProgress steps={steps.map((s) => ({ ...s, state: "done" }))} />

            <div className="font-jetbrains mt-8 flex flex-wrap gap-4 text-[12px] text-white/60">
              <span>{result.duration}s audio</span>
              <span>{result.speakers.length} speaker(s) · target <span className="text-white">{result.target}</span></span>
              <span>{result.utterances} utterances</span>
            </div>

            <h2 className="font-instrument mt-6 text-2xl text-white">Proposed voices</h2>
            <p className="mt-1 text-sm text-white/60">Toggle which emotions to keep. Ineligible ones are too short — descope or extend later.</p>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {result.stems.map((st) => {
                const on = selected.has(st.emotion);
                const m = emotionMeta(st.emotion);
                return (
                  <div key={st.emotion} className={`glass-panel rounded-2xl p-4 transition ${on ? "" : "opacity-60"}`}
                    style={on ? { borderColor: `hsl(${m.hue} 70% 55% / .4)` } : undefined}>
                    <div className="flex items-center gap-3">
                      <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
                        <EmotionArt emotion={st.emotion} size={38} dim={!st.eligible && !on} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-base font-medium text-white">{m.label}</span>
                          {!st.eligible && <span className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">short</span>}
                        </div>
                        <div className="font-jetbrains text-[11px] text-white/55">{st.seconds}s · {st.segments} seg</div>
                      </div>
                      <button onClick={() => preview(st.emotion)} aria-label="Preview"
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110">
                        {playing === st.emotion ? "⏸" : "▶"}
                      </button>
                      <button onClick={() => toggle(st.emotion)} aria-pressed={on}
                        className={`font-jetbrains shrink-0 rounded-lg border px-2.5 py-1 text-[11px] transition ${on ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/55 hover:text-white"}`}>
                        {on ? "✓ keep" : "descope"}
                      </button>
                    </div>
                    {st.cues.length > 0 && (
                      <p className="mt-2 line-clamp-1 pl-14 text-[11px] italic text-white/45">“{st.cues[0]}”</p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* assign */}
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
                <Button onClick={commit} disabled={selected.size === 0} className="ml-auto cursor-pointer">
                  {mode === "new" ? "Create character" : "Add to character"} ({selected.size})
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* COMMITTING */}
        {phase === "committing" && (
          <div className="mt-16 text-center">
            <div className="font-jetbrains text-[12px] uppercase tracking-widest text-cyan-300">cloning {selected.size} voice(s)…</div>
            <p className="mt-2 text-sm text-white/60">Each emotion is being cloned on the CPU engine (~15s each).</p>
          </div>
        )}

        {/* DONE */}
        {phase === "done" && (
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
