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
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import { DEFAULT_BASE_URL, KEY_PLACEHOLDER, SNIPPET_LANGS, type SnippetLang } from "@/lib/switchkit";
import { formatMeta } from "@/lib/audioFormats";
import { readEdits, type EditRegion, type Take } from "./shared";

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

/** One punched region as its own /v1/speak body — the patch call. A per-region
 *  emotion is a metatag, not a parameter (emotions are separate Voices), so the
 *  text below is exactly what the studio sent. */
function patchBody(t: Take, r: EditRegion): string {
  return JSON.stringify(
    { character_id: r.characterId ?? t.characterId, text: r.text, voice_settings: voiceSettings(t) },
    null,
    2,
  );
}

/**
 * The reproduction recipe for a PUNCHED take: the base render, then one call per
 * patched region, then the one step that happened in the browser.
 *
 * Without this a spliced take's export was a lie — it printed the base call and
 * claimed those bytes, when the audio the user is holding is the base with N
 * regions replaced.
 */
function editsComment(t: Take, lang: SnippetLang): string[] {
  const edits = readEdits(t);
  if (!edits || edits.regions.length === 0) return [];
  const hash = lang === "curl" || lang === "python" ? "#" : "//";
  const out = [
    ``,
    `${hash} ── this take was PUNCHED IN: base call above, then ${edits.regions.length} patch call${edits.regions.length === 1 ? "" : "s"} ──`,
    `${hash} base take: ${edits.source}`,
  ];
  for (const r of edits.regions) {
    out.push(
      `${hash} segment ${r.i + 1}${r.emotion ? ` · [${r.emotion}]` : ""} → POST /v1/speak?output_format=wav_24000`,
      ...patchBody(t, r).split("\n").map((l) => `${hash}   ${l}`),
    );
  }
  out.push(
    `${hash} then: decode both, replace segment ${edits.regions.map((r) => r.i + 1).join(", ")} at the segment`,
    `${hash} boundary with a 12 ms crossfade, re-master as wav. The splice is client-side —`,
    `${hash} the service has no edit endpoint, and this take's audio is that concatenation.`,
  );
  return out;
}

function buildSnippet(lang: SnippetLang, t: Take, apiKey: string): string {
  const base = DEFAULT_BASE_URL;
  const isPerf = !!t.lines?.length;
  // Both premium routes take the same `output_format` grammar as the drop-in
  // route. The snippet names the format this take was actually rendered as, so
  // pasting it reproduces the file the user is holding — and teaches the
  // parameter, which is where the rest of the grammar (pcm, other rates and
  // bitrates) lives.
  const fmt = formatMeta(t.format);
  const path = `${isPerf ? "/v1/performance" : "/v1/speak"}?output_format=${fmt.id}`;
  const body = isPerf ? performanceBody(t) : speakBody(t);
  const reportComment = isPerf
    ? `# per-line/segment report: X-Performance-Report header (base64 JSON)`
    : `# per-segment emotion report: X-Segments header (base64 JSON)`;
  const patches = editsComment(t, lang);
  switch (lang) {
    case "curl":
      return [
        `curl -X POST "${base}${path}" \\`,
        `  -H "xi-api-key: ${apiKey}" -H "Content-Type: application/json" \\`,
        `  -d '${body.replace(/'/g, "'\\''")}' \\`,
        `  --output take.${fmt.ext}`,
        reportComment,
        ...patches,
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
        `open("take.${fmt.ext}", "wb").write(r.content)`,
        ...patches,
      ].join("\n");
    case "javascript":
      return [
        `const res = await fetch("${base}${path}", {`,
        `  method: "POST",`,
        `  headers: { "xi-api-key": "${apiKey}", "Content-Type": "application/json" },`,
        `  body: JSON.stringify(${body.replace(/\n/g, "\n  ")}),`,
        `});`,
        `const audio = await res.arrayBuffer(); // ${fmt.mime}`,
        ...patches,
      ].join("\n");
  }
}

export default function TakeCode({ take }: { take: Take }) {
  const { user } = useAuth();
  const [lang, setLang] = useState<SnippetLang>("curl");
  const { copy: copyText, copied, failed } = useCopyFeedback();

  const storedKey = useMemo(() => (user ? getStoredKey(user.uid) : null), [user]);
  const snippet = buildSnippet(lang, take, storedKey?.secret ?? KEY_PLACEHOLDER);

  const copy = () => copyText(snippet);

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
          {failed ? "copy blocked — select it" : copied ? "✓ copied" : storedKey ? "copy with my key" : "copy snippet"}
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
