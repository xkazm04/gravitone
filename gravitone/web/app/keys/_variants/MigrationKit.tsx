"use client";

// ElevenLabs migration wizard — rendered inside the key-reveal moment.
// The freshly minted secret is pre-filled into base-URL-swap snippets, and a
// compatibility check replays a real ElevenLabs-shaped request against this
// Gravitone deployment and reports the timing headers.
//
// WHAT THE CHECK ACTUALLY PROVES: it goes through the studio's own server-side
// proxy (/api/tts), which is the only path a browser has — CORS is closed by
// default (service/app.py::cors_policy), so a direct call from this page would
// die at the preflight. That makes the green tick evidence that the deployment
// SERVES an ElevenLabs-shaped request, and no evidence at all that a browser
// can reach it. It says so rather than letting a green tick sit next to a
// browser snippet that would fail. Loosening CORS is NOT the fix — the
// default-closed posture was chosen deliberately.

import { useEffect, useState } from "react";
import { readDetail } from "@/lib/apiFetch";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { migrationSnippet, SNIPPET_LANGS, type SnippetLang } from "@/lib/switchkit";
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import AgentBlocks from "./AgentBlocks";

// The fourth tab is not a fourth language. curl / python / javascript migrate a
// HUMAN's codebase; "agents" hands the same key to a runtime that reads instead
// of being read to — an MCP server config or a tool-schema array, derived from
// this key's own manifest. It sits behind the same switcher because it is the
// same decision (how do I call this deployment?), made by a different caller.
type Tab = SnippetLang | "agents";
const TABS: Tab[] = [...SNIPPET_LANGS, "agents"];

type CheckState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "pass"; audioSeconds: string; rtf: string }
  | { phase: "fail"; reason: string };

export default function MigrationKit({ apiKey, keyId }: { apiKey: string; keyId: string }) {
  const [tab, setTab] = useState<Tab>("curl");
  const { copy: copyText, copied, failed, reset: resetCopied } = useCopyFeedback();
  const [check, setCheck] = useState<CheckState>({ phase: "idle" });

  useEffect(() => {
    setCheck({ phase: "idle" });
    resetCopied();
  }, [apiKey, resetCopied]);

  // The agents tab renders its own blocks (and its own copy affordance), so the
  // snippet below is only meaningful for the three language tabs.
  const lang: SnippetLang | null = tab === "agents" ? null : tab;
  const snippet = lang ? migrationSnippet(lang, { apiKey }) : "";

  const copy = () => copyText(snippet);

  // Replays the same request shape an ElevenLabs client sends, server-to-server
  // through the studio proxy — see the module header for what that does and
  // does not prove.
  const runCheck = async () => {
    setCheck({ phase: "running" });
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Compatibility check: one base URL, zero code changes.", voiceId: "alba" }),
      });
      if (!r.ok) {
        // The backend's own detail ("no such voice", "engine not ready", a 401
        // naming the missing scope) is the whole diagnostic value of a failed
        // check. Collapsing every non-OK to `upstream {status}` threw it away.
        const detail = await readDetail(r);
        setCheck({
          phase: "fail",
          reason: detail ?? (r.status === 503 ? "Gravitone backend unreachable" : `upstream ${r.status}`),
        });
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
          {tab === "agents" ? "give this key to an agent" : "switch from elevenlabs — one line"}
        </span>
        <div className="flex gap-1.5">
          {TABS.map((l) => (
            <button
              key={l} onClick={() => setTab(l)}
              className={`font-jetbrains cursor-pointer rounded-full border px-2 py-0.5 text-[10px] transition ${
                l === tab ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* The agents tab is a different artifact, not a different snippet: it is
          derived from this key's manifest, so it stops at the key's scopes. */}
      {tab === "agents" ? (
        <div className="mt-3">
          <AgentBlocks keyId={keyId} secret={apiKey} />
        </div>
      ) : (
      <>
      <pre className="font-jetbrains mt-3 max-h-44 overflow-auto rounded-xl border border-white/8 bg-black/40 p-3 text-[11px] leading-relaxed text-cyan-100/90">
        {snippet}
      </pre>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={copy}
          className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/85 transition hover:bg-white/5"
        >
          {failed ? "copy blocked — select it" : copied ? "✓ copied" : "copy snippet with key"}
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
        {/* Rose, not amber: a failed check is a failure, and the repo reserves
            amber for a caveat (components/ui/ErrorBanner). */}
        {check.phase === "fail" && (
          <span className="font-jetbrains text-[11px] text-rose-300">✗ {check.reason}</span>
        )}
      </div>

      {/* Say which path was checked, in the same breath as the result — a green
          tick with no path named is what let it stand in for the browser call
          the snippet next to it makes. */}
      {check.phase === "pass" && (
        <p className="font-jetbrains mt-2 text-[10px] leading-relaxed text-white/50">
          Checked server-to-server through this studio&apos;s proxy — the path the curl and Python snippets take.
          It does not prove a <span className="text-white/70">browser</span> can call your deployment: that needs
          CORS, which is closed until <span className="text-white/70">TTS_CORS_ORIGINS</span> names your origin.
        </p>
      )}

      {lang === "javascript" && (
        <ErrorBanner severity="warning" className="mt-3">
          This snippet runs in a browser, and the check above never exercised that path. On a default deployment
          the preflight fails before your key is even sent — set TTS_CORS_ORIGINS to your origin, or run this
          server-side (Node, an edge function, your own API), where it works as written.
        </ErrorBanner>
      )}
      </>
      )}
    </div>
  );
}
