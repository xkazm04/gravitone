"use client";

// Hero mic demo — the landing's live proof. A visitor reads ~16 seconds into
// the mic, the CPU backend clones the voice, and SAMPLE_TEXT plays back in
// THEIR voice — no account required. The demo character is deleted right
// after synthesis; keeping voices is the sign-in hook.
//
// This component IS the hero glass panel: idle state renders the decorative
// "now generating" card, the demo states take it over.

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { HERO_DEMO, SAMPLE_TEXT } from "@/lib/content";
import { useAuth } from "@/lib/useAuth";
import { CONSENT_STATEMENT } from "@/lib/consent";
import Equalizer from "@/components/ui/Equalizer";

const MIN_SECONDS = 8;
const MAX_SECONDS = 20;
const ease = [0.22, 1, 0.36, 1] as const;

type Phase = "idle" | "recording" | "cloning" | "rendering" | "ready" | "error";

export default function HeroMicDemo() {
  const { ready, signIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanupMic = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    recRef.current?.stream.getTracks().forEach((t) => t.stop());
    recRef.current = null;
  }, []);
  useEffect(() => () => { cleanupMic(); if (audioUrl) URL.revokeObjectURL(audioUrl); }, [cleanupMic, audioUrl]);

  const fail = (msg: string) => { setError(msg); setPhase("error"); };

  /** clone the recording → synthesize SAMPLE_TEXT with it → delete the demo character */
  const runPipeline = useCallback(async (blob: Blob) => {
    const demoName = `Demo visitor ${Math.random().toString(16).slice(2, 6)}`;
    // The id to delete comes from the backend's clone response, NOT a re-slug
    // of demoName — the client and server slug rules differ, so a reconstructed
    // id can silently miss and leave the cloned (biometric) demo voice behind.
    let createdCid: string | null = null;
    try {
      setPhase("cloning");
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      const fd = new FormData();
      fd.append("file", new File([blob], `hero-demo.${ext}`, { type: blob.type }));
      fd.append("character", demoName);
      fd.append("emotion", "baseline");
      // The visitor is recording their own voice live — self-attestation.
      fd.append("attested", "true");
      fd.append("statement", CONSENT_STATEMENT);
      const cr = await fetch("/api/voices", { method: "POST", body: fd });
      const voice = await cr.json().catch(() => ({}));
      if (!cr.ok) throw new Error(voice?.detail ?? "clone failed");
      // A 200 with no voice_id would otherwise fall through to /api/tts, which
      // defaults to a stock voice — playing a stranger's voice as "yours,
      // cloned." Fail loudly instead of faking the core demo.
      if (!voice.voice_id) throw new Error("clone returned no voice — please try again");
      createdCid = voice.character_id ?? null;

      setPhase("rendering");
      const tr = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: SAMPLE_TEXT, voiceId: voice.voice_id }),
      });
      if (!tr.ok) throw new Error("synthesis failed");
      const wav = await tr.arrayBuffer();
      setAudioUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      });
      setPhase("ready");
    } catch (e) {
      fail(e instanceof Error ? e.message : "demo failed — the backend may be offline");
    } finally {
      // The demo never keeps data: delete the throwaway character by its real
      // id. Nothing to delete if the clone never returned one.
      if (createdCid) {
        void fetch(`/api/characters/${encodeURIComponent(createdCid)}`, { method: "DELETE" }).catch(() => {});
      }
    }
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        cleanupMic();
        void runPipeline(blob);
      };
      recRef.current = rec;
      rec.start();
      setSeconds(0);
      setPhase("recording");
      timerRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_SECONDS) recRef.current?.stop();
          return s + 1;
        });
      }, 1000);
    } catch {
      fail("microphone unavailable — allow mic access and try again");
    }
  }, [cleanupMic, runPipeline]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.9, ease, delay: 0.2 }}
      className="glass-panel relative rounded-3xl p-6 shadow-2xl"
    >
      <div className="flex items-center justify-between">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
          {phase === "idle" && "● now generating"}
          {phase === "recording" && "● recording you"}
          {(phase === "cloning" || phase === "rendering") && "● cloning on cpu"}
          {phase === "ready" && "● your voice, cloned"}
          {phase === "error" && "● demo hiccup"}
        </span>
        <span className="font-jetbrains text-[11px] text-white/60">24kHz · cpu</span>
      </div>

      {phase === "idle" && (
        <>
          <p className="font-instrument mt-5 text-xl italic leading-snug text-white/90">“{SAMPLE_TEXT}”</p>
          <div className="mt-6 rounded-2xl border border-white/8 bg-black/30 p-5">
            <Equalizer bars={40} className="h-16" />
            <div className="mt-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-cyan-300 text-slate-950">▶</span>
                <div>
                  <div className="text-sm text-white">Your voice</div>
                  <div className="font-jetbrains text-[11px] text-white/60">cloned · 16s sample</div>
                </div>
              </div>
              <button
                onClick={() => void startRecording()}
                className="cta-glow cursor-pointer rounded-full bg-gradient-to-r from-cyan-300 to-cyan-200 px-4 py-2 text-[13px] font-semibold text-slate-950 transition hover:brightness-110"
              >
                🎙 {HERO_DEMO.cta}
              </button>
            </div>
          </div>
        </>
      )}

      {phase === "recording" && (
        <>
          <p className="mt-4 text-sm text-white/65">Read this naturally — stop any time after {MIN_SECONDS}s:</p>
          <blockquote className="font-hanken mt-3 rounded-2xl border border-white/8 bg-black/30 p-4 text-[15px] leading-relaxed text-white/90">
            {HERO_DEMO.readScript}
          </blockquote>
          <div className="mt-4 flex items-center justify-between">
            <span className="font-jetbrains inline-flex items-center gap-2 text-[13px] text-rose-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" /> {seconds}s / {MAX_SECONDS}s
            </span>
            <button
              onClick={() => recRef.current?.stop()}
              disabled={seconds < MIN_SECONDS}
              className="cursor-pointer rounded-full bg-cyan-300 px-4 py-2 text-[13px] font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-40"
            >
              ■ Stop & clone
            </button>
          </div>
        </>
      )}

      {(phase === "cloning" || phase === "rendering") && (
        <div className="mt-6 rounded-2xl border border-white/8 bg-black/30 p-5">
          <Equalizer bars={40} className="h-16" />
          <p className="font-jetbrains mt-4 text-[12px] text-cyan-300">
            {phase === "cloning" ? "cloning your voice on the CPU…" : "rendering your line…"}
          </p>
          <p className="font-jetbrains mt-1 text-[11px] text-white/50">no GPU involved — this is the whole pitch</p>
        </div>
      )}

      {phase === "ready" && audioUrl && (
        <>
          <p className="font-instrument mt-5 text-xl italic leading-snug text-white/90">“{SAMPLE_TEXT}”</p>
          <div className="mt-4 rounded-2xl border border-cyan-400/20 bg-black/30 p-5">
            <audio src={audioUrl} controls autoPlay className="w-full" />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="font-jetbrains text-[11px] text-white/55">{HERO_DEMO.note}</span>
              <div className="flex gap-2">
                {ready && (
                  <button onClick={() => void signIn()}
                    className="cta-glow cursor-pointer rounded-full bg-gradient-to-r from-cyan-300 to-cyan-200 px-4 py-2 text-[12px] font-semibold text-slate-950 transition hover:brightness-110">
                    {HERO_DEMO.keepCta}
                  </button>
                )}
                <button onClick={() => setPhase("idle")}
                  className="font-jetbrains cursor-pointer rounded-full border border-white/15 px-3 py-2 text-[12px] text-white/80 transition hover:bg-white/5">
                  again
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {phase === "error" && (
        <div className="mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/5 p-5">
          <p className="text-sm text-amber-200/90">{error}</p>
          <button onClick={() => setPhase("idle")}
            className="font-jetbrains mt-3 cursor-pointer rounded-full border border-white/15 px-3 py-1.5 text-[12px] text-white/80 transition hover:bg-white/5">
            ← back
          </button>
        </div>
      )}
    </motion.div>
  );
}
