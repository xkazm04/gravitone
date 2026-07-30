"use client";

// Verification-phrase capture. Same MediaRecorder shape as the guided recorder
// in the voices tree (that one is welded to emotion capture + a clone upload,
// so its body cannot be reused here) — script on screen, record, play it back,
// keep or re-record.
//
// The audio is NEVER uploaded: there is no audio store, and inventing one to
// hold a biometric would be a bigger promise than this feature makes. What is
// persisted is that the phrase WAS read back, and for how long. The record is
// the artifact; the recording is the ritual that produces it.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Primitives";
import TakePlayer from "@/components/ui/TakePlayer";

const MIN_SECONDS = 3;
const MAX_SECONDS = 30;

type Phase = "idle" | "recording" | "done";

export default function PhraseRecorder({
  phrase, onRecorded,
}: {
  phrase: string;
  /** seconds captured, or null when the take is discarded. */
  onRecorded: (seconds: number | null) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    recRef.current?.stream.getTracks().forEach((t) => t.stop());
    recRef.current = null;
  }, []);

  // Drop the mic and the object URL on unmount — a live mic left running on a
  // consent page is exactly the wrong impression to leave.
  useEffect(() => () => {
    cleanup();
    setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); return null; });
  }, [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    onRecorded(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const b = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(b); });
        const took = elapsedRef.current;
        setPhase("done");
        cleanup();
        onRecorded(took >= MIN_SECONDS ? took : null);
      };
      recRef.current = rec;
      rec.start();
      elapsedRef.current = 0;
      setSeconds(0);
      setPhase("recording");
      timerRef.current = setInterval(() => {
        // The auto-stop lives outside the state updater — updaters must stay
        // pure, and StrictMode double-invokes them.
        elapsedRef.current += 1;
        setSeconds(elapsedRef.current);
        if (elapsedRef.current >= MAX_SECONDS) recRef.current?.stop();
      }, 1000);
    } catch {
      setError("microphone unavailable — allow mic access, or sign without recording below");
    }
  }, [cleanup, onRecorded]);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    recRef.current?.stop();
  }, []);

  const tooShort = phase === "done" && seconds < MIN_SECONDS;

  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/55">
        read this out loud
      </div>
      <blockquote className="font-hanken mt-2 rounded-xl border border-white/10 bg-black/40 p-3 text-[15px] leading-relaxed text-white/90">
        {phrase}
      </blockquote>

      {error && <ErrorBanner className="mt-3">{error}</ErrorBanner>}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {phase === "idle" && (
          <Button onClick={() => void start()} className="cursor-pointer">● Record the phrase</Button>
        )}
        {phase === "recording" && (
          <>
            <Button onClick={stop} className="cursor-pointer">■ Stop</Button>
            <span className="font-jetbrains inline-flex items-center gap-2 text-[13px] text-rose-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" /> {seconds}s
            </span>
          </>
        )}
        {phase === "done" && (
          <>
            {previewUrl && <TakePlayer src={previewUrl} compact label="your phrase" className="max-w-[240px]" />}
            <button onClick={() => void start()} className="font-jetbrains cursor-pointer text-[12px] text-white/65 transition hover:text-white">
              ↺ re-record
            </button>
            {tooShort
              ? <span className="font-jetbrains text-[11px] text-amber-300">too short — read the whole phrase ({MIN_SECONDS}s minimum)</span>
              : <span className="font-jetbrains text-[13px] text-emerald-300">✓ phrase read back ({seconds}s)</span>}
          </>
        )}
      </div>
      <p className="font-jetbrains mt-2 text-[11px] text-white/40">
        The audio stays in this browser — it is never uploaded. Your consent record notes that you
        read the phrase, not what it sounded like.
      </p>
    </div>
  );
}
