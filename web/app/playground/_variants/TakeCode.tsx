"use client";

// "Get this as code" — every take carries its exact reproduction recipe
// (character_id, metatagged text, expression knobs). This panel renders it as
// ready-to-paste curl / Python / JS against the ElevenLabs-compatible
// /v1/speak endpoint, pre-filled with the signed-in user's API key from
// localStorage (minted at sign-in) or a create-key CTA when absent.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/useAuth";
import { getStoredKey } from "@/lib/mintKey";
import { DEFAULT_BASE_URL, KEY_PLACEHOLDER, SNIPPET_LANGS, type SnippetLang } from "@/lib/switchkit";
import type { Take } from "./shared";

const voiceSettings = (t: Take) => ({
  temperature: t.expr.temperature,
  stability: t.expr.stability,
  quality: t.expr.quality,
});

function speakBody(t: Take): string {
  return JSON.stringify(
    { character_id: t.characterId, text: t.text, voice_settings: voiceSettings(t) },
    null,
    2,
  );
}

// Performance takes replay through /v1/performance — the directed multi-line
// script the take carries, each line's voice_settings mirroring the take's knobs.
function performanceBody(t: Take): string {
  return JSON.stringify(
    { lines: (t.lines ?? []).map((l) => ({ ...l, voice_settings: voiceSettings(t) })) },
    null,
    2,
  );
}

function buildSnippet(lang: SnippetLang, t: Take, apiKey: string): string {
  const base = DEFAULT_BASE_URL;
  const isPerf = !!t.lines?.length;
  const path = isPerf ? "/v1/performance" : "/v1/speak";
  const body = isPerf ? performanceBody(t) : speakBody(t);
  const reportComment = isPerf
    ? `# per-line/segment report: X-Performance-Report header (base64 JSON)`
    : `# per-segment emotion report: X-Segments header (base64 JSON)`;
  switch (lang) {
    case "curl":
      return [
        `curl -X POST "${base}${path}" \\`,
        `  -H "xi-api-key: ${apiKey}" -H "Content-Type: application/json" \\`,
        `  -d '${body.replace(/'/g, "'\\''")}' \\`,
        `  --output take.wav`,
        reportComment,
      ].join("\n");
    case "python":
      return [
        `import requests`,
        ``,
        `r = requests.post(`,
        `    "${base}${path}",`,
        `    headers={"xi-api-key": "${apiKey}"},`,
        `    json=${body.replace(/\n/g, "\n    ")},`,
        `)`,
        `open("take.wav", "wb").write(r.content)`,
      ].join("\n");
    case "javascript":
      return [
        `const res = await fetch("${base}${path}", {`,
        `  method: "POST",`,
        `  headers: { "xi-api-key": "${apiKey}", "Content-Type": "application/json" },`,
        `  body: JSON.stringify(${body.replace(/\n/g, "\n  ")}),`,
        `});`,
        `const audio = await res.arrayBuffer(); // wav`,
      ].join("\n");
  }
}

export default function TakeCode({ take }: { take: Take }) {
  const { user } = useAuth();
  const [lang, setLang] = useState<SnippetLang>("curl");
  const [copied, setCopied] = useState(false);

  const storedKey = useMemo(() => (user ? getStoredKey(user.uid) : null), [user]);
  const snippet = buildSnippet(lang, take, storedKey?.secret ?? KEY_PLACEHOLDER);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* selectable anyway */ }
  };

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          this take as an api call
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
      <pre className="font-jetbrains mt-2 max-h-52 overflow-auto rounded-lg border border-white/8 bg-black/40 p-3 text-[11px] leading-relaxed text-cyan-100/90">
        {snippet}
      </pre>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button onClick={copy}
          className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/85 transition hover:bg-white/5">
          {copied ? "✓ copied" : storedKey ? "copy with my key" : "copy snippet"}
        </button>
        {!storedKey && (
          <Link href="/profile" className="font-jetbrains text-[11px] text-cyan-300/80 underline-offset-2 transition hover:text-cyan-200 hover:underline">
            mint an API key to pre-fill this →
          </Link>
        )}
      </div>
    </div>
  );
}
