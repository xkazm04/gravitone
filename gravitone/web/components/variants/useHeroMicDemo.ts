"use client";

/*
 * The hero demo's state machine: the microphone, the clone→synthesize pipeline
 * it feeds, and the throwaway character it cleans up after itself. Everything
 * ./HeroMicDemo.tsx does that is not the glass panel it draws.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { SAMPLE_TEXT } from "@/lib/content";
import { CONSENT_STATEMENT } from "@/lib/consent";
import { getEngine } from "@/lib/engineSeam";
import { useAudioBus, useSignalWorking } from "@/components/ui/AudioBus";

export const MIN_SECONDS = 8;
export const MAX_SECONDS = 20;

export type Phase = "idle" | "recording" | "cloning" | "rendering" | "ready" | "error";

export function useHeroMicDemo() {
  const bus = useAudioBus();
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // `--gt-working`: while the CPU is cloning/rendering, the whole frame leans in.
  // The pitch of this demo is "no GPU" — the studio showing it is working is the
  // proof, and it replaces nothing (the spinner copy stays).
  useSignalWorking(phase === "cloning" || phase === "rendering");

  const cleanupMic = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    bus.unregisterStream(recRef.current?.stream);
    recRef.current?.stream.getTracks().forEach((t) => t.stop());
    recRef.current = null;
  }, [bus]);
  useEffect(() => () => { cleanupMic(); if (audioUrl) URL.revokeObjectURL(audioUrl); }, [cleanupMic, audioUrl]);

  const fail = (msg: string) => { setError(msg); setPhase("error"); };

  /** clone the recording → synthesize SAMPLE_TEXT with it → delete the demo character */
  const runPipeline = useCallback(async (blob: Blob) => {
    const demoName = `Demo visitor ${Math.random().toString(16).slice(2, 6)}`;
    // The id to delete comes from the backend's clone response, NOT a re-slug
    // of demoName — the client and server slug rules differ, so a reconstructed
    // id can silently miss and leave the cloned (biometric) demo voice behind.
    let createdCid: string | null = null;
    const controller = new AbortController();
    abortRef.current = controller;
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
      const cr = await fetch("/api/voices", { method: "POST", body: fd, signal: controller.signal });
      const voice = await cr.json().catch(() => ({}));
      if (!cr.ok) throw new Error(voice?.detail ?? "clone failed");
      // A 200 with no voice_id would otherwise fall through to /api/tts, which
      // defaults to a stock voice — playing a stranger's voice as "yours,
      // cloned." Fail loudly instead of faking the core demo.
      if (!voice.voice_id) throw new Error("clone returned no voice — please try again");
      createdCid = voice.character_id ?? null;

      setPhase("rendering");
      // Through the engine seam (lib/engineSeam) rather than a hand-rolled
      // fetch: the hero is the loudest claim the product makes about WHERE
      // audio is made, so it must ask the same object the studio asks. Today
      // that object is always the server engine; when a local one exists this
      // line is where "your voice never left the tab" becomes literally true.
      const audio = await getEngine().synthesize({
        kind: "voice", text: SAMPLE_TEXT, voiceId: voice.voice_id,
        signal: controller.signal,
      });
      setAudioUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return audio.url;
      });
      setPhase("ready");
    } catch (e) {
      // A user-initiated cancel aborts both fetches; stay quietly on idle
      // (cancel() already set the phase) rather than showing an error.
      if (!controller.signal.aborted) {
        fail(e instanceof Error ? e.message : "demo failed — the backend may be offline");
      }
    } finally {
      // The demo never keeps data: delete the throwaway character by its real
      // id. Nothing to delete if the clone never returned one.
      if (createdCid) {
        void fetch(`/api/characters/${encodeURIComponent(createdCid)}`, { method: "DELETE" }).catch(() => {});
      }
    }
  }, []);

  // Escape hatch while cloning/rendering: abort the in-flight fetches (a
  // stalled CPU backend can hold the demo ~5 min otherwise) and return to idle.
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setError(null);
    setPhase("idle");
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The equalizer above the recorder now shows the visitor's OWN voice —
      // tapped, never routed to the speakers (that would be feedback).
      bus.registerStream(stream);
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
      let elapsed = 0;
      timerRef.current = setInterval(() => {
        // Auto-stop outside the state updater — updaters must be pure, and
        // StrictMode double-invokes them (same fix as GuidedRecorder).
        elapsed += 1;
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS) recRef.current?.stop();
      }, 1000);
    } catch {
      fail("microphone unavailable — allow mic access and try again");
    }
  }, [bus, cleanupMic, runPipeline]);

  /** The visitor pressing "stop & clone" — the recorder's own onstop then runs
   *  the pipeline, exactly as the auto-stop above does. */
  const stopRecording = () => recRef.current?.stop();

  return { phase, setPhase, seconds, error, audioUrl, startRecording, stopRecording, cancel };
}
