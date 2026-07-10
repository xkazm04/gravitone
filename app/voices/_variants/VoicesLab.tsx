"use client";

// VOICE LAB — wildcard. Pushes past "upload + list": capture from the mic with a
// live level meter, analyse the sample's *clone readiness* (duration, level,
// clipping, silence) with actionable guidance, clone with suggested tags, get an
// instant preview, and run an A/B shootout between two voices on the same line.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { hueOf, useVoicePreview, useVoices, type Voice } from "./data";

type Analysis = {
  duration: number; peak: number; rms: number; clipping: number; silence: number;
  score: number; issues: string[]; suggested: string[];
};

async function analyze(blob: Blob): Promise<Analysis> {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const d = buf.getChannelData(0);
  let peak = 0, sum = 0, clip = 0, quiet = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) peak = a;
    sum += d[i] * d[i];
    if (a > 0.99) clip++;
    if (a < 0.01) quiet++;
  }
  void ctx.close();
  const duration = buf.duration;
  const rms = Math.sqrt(sum / d.length);
  const clipping = clip / d.length;
  const silence = quiet / d.length;

  const issues: string[] = [];
  let score = 100;
  if (duration < 8) { score -= 30; issues.push(`Only ${duration.toFixed(1)}s — aim for 10–30s.`); }
  else if (duration > 40) { score -= 10; issues.push("Longer than 40s — the model truncates at 30s."); }
  if (peak < 0.2) { score -= 25; issues.push("Very quiet — record closer to the mic."); }
  if (clipping > 0.005) { score -= 25; issues.push(`Clipping on ${(clipping * 100).toFixed(1)}% of samples — lower input gain.`); }
  if (silence > 0.45) { score -= 15; issues.push("Lots of silence — trim gaps for a denser sample."); }
  score = Math.max(0, Math.min(100, score));

  const suggested = [
    duration >= 10 && duration <= 30 && clipping < 0.005 ? "clean" : "needs-work",
    peak > 0.5 ? "loud" : "soft",
  ];
  return { duration, peak, rms, clipping, silence, score, issues, suggested };
}

export default function VoicesLab() {
  const { voices, error, createVoice, patchVoice } = useVoices();
  const { preview, playingId, busyId } = useVoicePreview();

  // ── capture ───────────────────────────────────────────────────────────────
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [sample, setSample] = useState<{ blob: Blob; filename: string } | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function takeSample(blob: Blob, filename: string) {
    setSample({ blob, filename });
    setAnalysis(null);
    try {
      const a = await analyze(blob);
      setAnalysis(a);
      setTags(a.suggested.filter((t) => t !== "needs-work"));
    } catch { setAnalysis(null); }
  }

  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AC = window.AudioContext;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let m = 0;
        for (const b of buf) m = Math.max(m, Math.abs(b - 128) / 128);
        setLevel(m);
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        setLevel(0);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        void takeSample(new Blob(chunksRef.current, { type: "audio/webm" }), "recording.webm");
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch {
      setCloneErr("Microphone access denied — upload a file instead.");
    }
  }
  function stopRec() { recRef.current?.stop(); setRecording(false); }

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  async function clone() {
    if (!sample || !name.trim() || cloning) return;
    setCloning(true); setCloneErr(null);
    try {
      const v = await createVoice(sample.blob, name.trim(), tags, sample.filename);
      setSample(null); setAnalysis(null); setName(""); setTags([]);
      setTimeout(() => void preview(v), 300); // instant preview of the new voice
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : "clone failed");
    } finally { setCloning(false); }
  }

  // ── A/B shootout ──────────────────────────────────────────────────────────
  const [a, setA] = useState(""); const [b, setB] = useState("");
  const [line, setLine] = useState("The quick brown fox jumps over the lazy dog.");
  const va = voices.find((v) => v.voice_id === a);
  const vb = voices.find((v) => v.voice_id === b);
  useEffect(() => {
    if (!a && voices[0]) setA(voices[0].voice_id);
    if (!b && voices[1]) setB(voices[1].voice_id);
  }, [voices, a, b]);

  function crown(v?: Voice) {
    if (!v) return;
    if (!v.tags.includes("favorite")) patchVoice(v.voice_id, { tags: [...v.tags, "favorite"] });
  }

  const scoreColor = useMemo(() => {
    if (!analysis) return "text-white/50";
    return analysis.score >= 75 ? "text-emerald-300" : analysis.score >= 45 ? "text-amber-300" : "text-rose-300";
  }, [analysis]);

  return (
    <div className="pb-24">
      <Eyebrow>voice lab</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">Capture, grade, clone.</h1>

      {error && (
        <p className="font-jetbrains mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">{error}</p>
      )}

      <div className="mt-8 grid gap-5 lg:grid-cols-[1fr_1fr]">
        {/* capture */}
        <div className="glass-panel rounded-2xl p-6">
          <div className="font-jetbrains mb-4 text-[11px] uppercase tracking-widest text-white/40">1 · capture</div>

          <div className="flex h-20 items-end justify-center gap-[3px] rounded-xl border border-white/8 bg-black/25 px-4 py-3">
            {Array.from({ length: 40 }).map((_, i) => {
              const centre = 1 - Math.abs(i - 19.5) / 20;
              const h = recording ? Math.max(4, level * 100 * centre) : 4;
              return <span key={i} className="w-[3px] rounded-full bg-cyan-300/80 transition-[height] duration-75" style={{ height: `${h}%` }} />;
            })}
          </div>

          <div className="mt-4 flex items-center gap-3">
            {recording ? (
              <Button onClick={stopRec} variant="ghost">■ Stop recording</Button>
            ) : (
              <Button onClick={startRec}>● Record from mic</Button>
            )}
            <input ref={fileRef} type="file" accept="audio/*,video/mp4" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { void takeSample(f, f.name); if (!name) setName(f.name.replace(/\.[^.]+$/, "")); } }} />
            <button onClick={() => fileRef.current?.click()} className="font-jetbrains text-[12px] text-white/50 underline-offset-4 transition hover:text-white hover:underline">
              or upload a file
            </button>
          </div>

          {sample && <div className="font-jetbrains mt-3 text-[11px] text-white/45">sample: {sample.filename} · {(sample.blob.size / 1024).toFixed(0)} kb</div>}
        </div>

        {/* grade */}
        <div className="glass-panel rounded-2xl p-6">
          <div className="font-jetbrains mb-4 text-[11px] uppercase tracking-widest text-white/40">2 · clone readiness</div>

          {!analysis ? (
            <p className="text-sm text-white/40">Record or upload a sample to grade it.</p>
          ) : (
            <>
              <div className="flex items-baseline gap-3">
                <span className={`font-instrument text-5xl ${scoreColor}`}>{analysis.score}</span>
                <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/40">/ 100 readiness</span>
              </div>
              <div className="font-jetbrains mt-4 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                {[
                  ["length", `${analysis.duration.toFixed(1)}s`],
                  ["peak", analysis.peak.toFixed(2)],
                  ["clipping", `${(analysis.clipping * 100).toFixed(1)}%`],
                  ["silence", `${(analysis.silence * 100).toFixed(0)}%`],
                ].map(([k, v]) => (
                  <div key={k} className="rounded border border-white/8 bg-black/25 px-2 py-1.5">
                    <div className="text-white/40">{k}</div>
                    <div className="text-white">{v}</div>
                  </div>
                ))}
              </div>
              {analysis.issues.length > 0 ? (
                <ul className="mt-4 space-y-1 text-sm text-amber-200/85">
                  {analysis.issues.map((i) => <li key={i}>• {i}</li>)}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-emerald-300">Looks great — this should clone cleanly.</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* clone */}
      <div className="glass-panel mt-5 rounded-2xl p-6">
        <div className="font-jetbrains mb-4 text-[11px] uppercase tracking-widest text-white/40">3 · clone</div>
        <div className="flex flex-wrap items-center gap-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Voice name"
            className="font-hanken w-56 rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white placeholder:text-white/30 focus:border-cyan-400/40 focus:outline-none" />
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((t) => (
              <span key={t} className="font-jetbrains inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] text-white/75">
                {t}
                <button onClick={() => setTags(tags.filter((x) => x !== t))} className="text-white/35 hover:text-white">×</button>
              </span>
            ))}
            {analysis?.suggested.filter((s) => !tags.includes(s)).map((s) => (
              <button key={s} onClick={() => setTags([...tags, s])}
                className="font-jetbrains rounded-full border border-dashed border-cyan-400/30 px-2.5 py-1 text-[11px] text-cyan-300/80 hover:bg-cyan-400/10">
                + {s}
              </button>
            ))}
          </div>
          {cloneErr && <p className="font-jetbrains w-full text-[11px] text-rose-300">{cloneErr}</p>}
          <Button onClick={clone} disabled={!sample || !name.trim() || cloning} className="ml-auto">
            {cloning ? "Cloning…" : "Clone & preview"}
          </Button>
        </div>
      </div>

      {/* A/B shootout */}
      <div className="glass-panel mt-5 rounded-2xl p-6">
        <div className="font-jetbrains mb-4 text-[11px] uppercase tracking-widest text-white/40">4 · a/b shootout</div>
        <input value={line} onChange={(e) => setLine(e.target.value)}
          className="font-hanken w-full rounded-xl border border-white/12 bg-white/[0.03] px-4 py-3 text-base text-white focus:border-cyan-400/40 focus:outline-none" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {([[a, setA, va, "A"], [b, setB, vb, "B"]] as const).map(([id, set, v, side]) => (
            <div key={side} className="rounded-xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center gap-2">
                <span className="font-jetbrains text-[11px] text-white/40">{side}</span>
                <select value={id} onChange={(e) => set(e.target.value)}
                  className="font-jetbrains flex-1 rounded border border-white/12 bg-[#0d1017] px-2 py-1 text-[12px] text-white/85 focus:outline-none">
                  {voices.map((x) => <option key={x.voice_id} value={x.voice_id}>{x.name}</option>)}
                </select>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <span className="h-9 w-9 rounded-full" style={{ background: v ? `radial-gradient(circle at 30% 30%, hsl(${hueOf(v.voice_id)} 90% 70%), hsl(${hueOf(v.voice_id)} 80% 45%))` : "#333" }} />
                <button onClick={() => v && preview(v, line)} disabled={!v || busyId === v?.voice_id}
                  className="rounded-full bg-cyan-300 px-4 py-1.5 text-[12px] font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-50">
                  {busyId === v?.voice_id ? "…" : playingId === v?.voice_id ? "⏸ stop" : "▶ play line"}
                </button>
                <button onClick={() => crown(v)} className="font-jetbrains ml-auto text-[11px] text-white/40 transition hover:text-amber-300">
                  ★ crown
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="font-jetbrains mt-3 text-[11px] text-white/35">Crowning tags the winner <span className="text-amber-300/70">favorite</span> — it persists on the voice.</p>
      </div>
    </div>
  );
}
