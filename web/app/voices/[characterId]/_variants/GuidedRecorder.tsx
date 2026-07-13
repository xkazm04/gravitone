"use client";

// Guided emotion capture: script → record → preview → clone, then walk to the
// next empty slot. Replaces file-hunting with a one-sitting coverage session.
// MediaRecorder output (webm/mp4) is fine — the backend ffmpeg-normalizes it.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import EmotionArt from "@/components/ui/EmotionArt";
import { emotionMeta } from "@/lib/emotions";
import { CAPTURE_ORDER, scriptFor } from "@/lib/emotionScripts";

const MIN_SECONDS = 8;
const TARGET_SECONDS = 20;
const MAX_SECONDS = 45;

type Phase = "idle" | "recording" | "preview" | "cloning" | "done";

/** Next empty slot to record, walking the Character's FULL scale (base +
 *  custom). Base emotions keep their curated CAPTURE_ORDER; custom slots follow
 *  in scale order, so they're offered as "next" instead of never surfacing. */
function nextInScale(scale: string[], filled: string[]): string | null {
  const rank = (e: string) => {
    const i = CAPTURE_ORDER.indexOf(e);
    return i === -1 ? CAPTURE_ORDER.length + scale.indexOf(e) : i;
  };
  return [...scale].sort((a, b) => rank(a) - rank(b)).find((e) => !filled.includes(e)) ?? null;
}

export default function GuidedRecorder({
  emotion, characterName, scale, filledEmotions, onClone, onClose, onSwitch,
}: {
  emotion: string | null; // null = closed
  characterName: string;
  scale: string[]; // this Character's effective palette (base + custom slots)
  filledEmotions: string[];
  onClone: (emotion: string, file: File) => Promise<void>; // throws on failure
  onClose: () => void;
  onSwitch: (emotion: string) => void; // jump to the next slot in the session
}) {
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => setMounted(true), []);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    recRef.current?.stream.getTracks().forEach((t) => t.stop());
    recRef.current = null;
  }, []);

  // Reset per emotion; drop the mic and preview URL when leaving.
  useEffect(() => {
    setPhase("idle"); setSeconds(0); setError(null); setBlob(null);
    setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); return null; });
    return cleanup;
  }, [emotion, cleanup]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const b = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        setBlob(b);
        setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(b); });
        setPhase("preview");
        cleanup();
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
      setError("microphone unavailable — allow mic access and try again");
    }
  }, [cleanup]);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    recRef.current?.stop();
  }, []);

  const clone = useCallback(async () => {
    if (!emotion || !blob) return;
    setPhase("cloning"); setError(null);
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    try {
      await onClone(emotion, new File([blob], `${emotion}-take.${ext}`, { type: blob.type }));
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "clone failed");
      setPhase("preview");
    }
  }, [emotion, blob, onClone]);

  if (!mounted) return null;

  const meta = emotion ? emotionMeta(emotion) : null;
  const es = emotion ? scriptFor(emotion) : null;
  // After a successful clone this emotion is filled locally even before refresh.
  const filledNow = emotion && phase === "done" ? [...filledEmotions, emotion] : filledEmotions;
  const next = nextInScale(scale, filledNow);
  const total = scale.length;
  const tooShort = seconds > 0 && seconds < MIN_SECONDS;

  return createPortal(
    <AnimatePresence>
      {emotion && meta && es && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-4 backdrop-blur-md"
          onClick={() => { cleanup(); onClose(); }} role="dialog" aria-modal="true" aria-label={`Record ${meta.label}`}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.26, ease: EASE }} onClick={(e) => e.stopPropagation()}
            className="glass-panel max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl p-8"
          >
            <div className="flex items-center gap-4">
              <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-2xl border border-white/10 bg-black/50">
                <EmotionArt emotion={emotion} size={52} />
              </span>
              <div>
                <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
                  guided capture · {filledNow.length}/{total} recorded
                </div>
                <h2 className="font-instrument mt-1 text-2xl text-white">
                  {characterName} · <span style={{ color: `hsl(${meta.hue} 85% 68%)` }}>{meta.label}</span>
                </h2>
              </div>
            </div>

            <p className="mt-4 text-sm italic text-white/70">🎭 {es.direction}</p>
            <blockquote className="font-hanken mt-3 rounded-2xl border border-white/10 bg-black/30 p-4 text-[15px] leading-relaxed text-white/90">
              {es.script}
            </blockquote>
            <p className="font-jetbrains mt-2 text-[11px] text-white/50">
              aim for {TARGET_SECONDS}s+ (minimum {MIN_SECONDS}s, cuts at {MAX_SECONDS}s) — expression lives in this recording
            </p>

            {error && (
              <p className="font-jetbrains mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/90">{error}</p>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              {phase === "idle" && (
                <Button onClick={() => void start()} className="cursor-pointer">● Start recording</Button>
              )}
              {phase === "recording" && (
                <>
                  <Button onClick={stop} className="cursor-pointer">■ Stop</Button>
                  <span className="font-jetbrains inline-flex items-center gap-2 text-[13px] text-rose-300">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" /> {seconds}s
                  </span>
                </>
              )}
              {phase === "preview" && (
                <>
                  {previewUrl && <audio src={previewUrl} controls className="h-9 max-w-[240px]" />}
                  <Button onClick={() => void clone()} disabled={tooShort} className="cursor-pointer">
                    Clone {meta.label} ✓
                  </Button>
                  <button onClick={() => void start()} className="font-jetbrains cursor-pointer text-[12px] text-white/65 transition hover:text-white">
                    ↺ re-record
                  </button>
                  {tooShort && <span className="font-jetbrains text-[11px] text-amber-300">too short — {MIN_SECONDS}s minimum</span>}
                </>
              )}
              {phase === "cloning" && (
                <span className="font-jetbrains text-[13px] text-cyan-300">cloning voice… (~20s, the model loads once)</span>
              )}
              {phase === "done" && (
                <>
                  <span className="font-jetbrains text-[13px] text-emerald-300">✓ {meta.label} recorded</span>
                  {next ? (
                    <Button onClick={() => onSwitch(next)} className="cursor-pointer">
                      Next: {emotionMeta(next).label} →
                    </Button>
                  ) : (
                    <span className="font-jetbrains text-[13px] text-emerald-200">rack complete — {total}/{total} 🎉</span>
                  )}
                  <button onClick={() => { cleanup(); onClose(); }} className="font-jetbrains cursor-pointer text-[12px] text-white/65 transition hover:text-white">
                    done for now
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
