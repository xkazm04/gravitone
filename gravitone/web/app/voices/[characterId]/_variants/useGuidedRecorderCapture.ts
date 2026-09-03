"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const MIN_SECONDS = 8;
export const TARGET_SECONDS = 20;
export const MAX_SECONDS = 45;

export type Phase = "idle" | "recording" | "preview" | "cloning" | "done";

/** The microphone half of the guided session: the take, its timer, its preview
 *  object URL — and the one teardown that releases all three. */
export function useGuidedRecorderCapture(emotion: string | null) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      let elapsed = 0;
      timerRef.current = setInterval(() => {
        // The auto-stop lives OUTSIDE the state updater: updaters must be pure,
        // and React 19 StrictMode double-invokes them — calling rec.stop()
        // in there could fire the stop twice.
        elapsed += 1;
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS) recRef.current?.stop();
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

  return { phase, setPhase, seconds, error, setError, blob, previewUrl, cleanup, start, stop };
}
