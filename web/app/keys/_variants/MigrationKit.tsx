"use client";

// ElevenLabs migration wizard — rendered inside the key-reveal moment.
// The freshly minted secret is pre-filled into base-URL-swap snippets, and a
// compatibility check replays a real ElevenLabs-shaped request against this
// Gravitone deployment and reports the timing headers.

import { useEffect, useState } from "react";
import { migrationSnippet, SNIPPET_LANGS, type SnippetLang } from "@/lib/switchkit";

type CheckState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "pass"; audioSeconds: string; rtf: string }
  | { phase: "fail"; reason: string };

export default function MigrationKit({ apiKey }: { apiKey: string }) {
  const [lang, setLang] = useState<SnippetLang>("curl");
  const [copied, setCopied] = useState(false);
  const [check, setCheck] = useState<CheckState>({ phase: "idle" });

  useEffect(() => {
    setCheck({ phase: "idle" });
    setCopied(false);
  }, [apiKey]);

  const snippet = migrationSnippet(lang, { apiKey });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* selectable anyway */
    }
  };

  // Replays the same request shape an ElevenLabs client sends (via the
  // studio proxy, so it works from the browser without CORS).
  const runCheck = async () => {
    setCheck({ phase: "running" });
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Compatibility check: one base URL, zero code changes.", voiceId: "alba" }),
      });
      if (!r.ok) {
        setCheck({ phase: "fail", reason: r.status === 503 ? "backend unreachable" : `upstream ${r.status}` });
        return;
      }
      await r.arrayBuffer(); // drain the audio
      setCheck({
        phase: "pass",
        audioSeconds: r.headers.get("X-Audio-Seconds") ?? "?",
        rtf: r.headers.get("X-Realtime-Factor") ?? "?",
      });
    } catch {
      setCheck({ phase: "fail", reason: "request failed" });
    }
  };

  return (
    <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-4">
      <div className="flex items-center justify-between">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          switch from elevenlabs — one line
        </span>
        <div className="flex gap-1.5">
          {SNIPPET_LANGS.map((l) => (
            <button
              key={l} onClick={() => setLang(l)}
              className={`font-jetbrains cursor-pointer rounded-full border px-2 py-0.5 text-[10px] transition ${
                l === lang ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <pre className="font-jetbrains mt-3 max-h-44 overflow-auto rounded-xl border border-white/8 bg-black/40 p-3 text-[11px] leading-relaxed text-cyan-100/90">
        {snippet}
      </pre>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={copy}
          className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/85 transition hover:bg-white/5"
        >
          {copied ? "✓ copied" : "copy snippet with key"}
        </button>
        <button
          onClick={runCheck} disabled={check.phase === "running"}
          className="font-jetbrains cursor-pointer rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-1.5 text-[11px] text-cyan-200 transition hover:bg-cyan-400/10 disabled:opacity-50"
        >
          {check.phase === "running" ? "replaying request…" : "run compatibility check"}
        </button>
        {check.phase === "pass" && (
          <span className="font-jetbrains text-[11px] text-emerald-300">
            ✓ ElevenLabs-shaped request served — {check.audioSeconds}s audio at {check.rtf}× realtime
          </span>
        )}
        {check.phase === "fail" && (
          <span className="font-jetbrains text-[11px] text-amber-300">✗ {check.reason}</span>
        )}
      </div>
    </div>
  );
}
