"use client";

// Per-character API playground: ready-to-run recipes for the three ways to
// speak as this Character — emotion addressing on the ElevenLabs-compatible
// endpoint, inline metatags, and a multi-character performance script.

import { useMemo, useState } from "react";
import { DEFAULT_BASE_URL, KEY_PLACEHOLDER } from "@/lib/switchkit";

type Recipe = { id: string; label: string; hint: string; code: string };

function buildRecipes(characterId: string, filled: string[]): Recipe[] {
  const emotion = filled.find((e) => e !== "baseline") ?? "excited";
  const base = DEFAULT_BASE_URL;
  return [
    {
      id: "address",
      label: "emotion address",
      hint: "ElevenLabs-compatible endpoint — the voice_id is character:emotion; missing emotions fall back to baseline (see X-Emotion-* headers).",
      code: [
        `curl -X POST "${base}/v1/text-to-speech/${characterId}:${emotion}" \\`,
        `  -H "xi-api-key: ${KEY_PLACEHOLDER}" -H "Content-Type: application/json" \\`,
        `  -d '{"text": "One character, many moods."}' --output line.wav`,
      ].join("\n"),
    },
    {
      id: "metatags",
      label: "inline metatags",
      hint: "One call, emotions switching mid-script; the per-segment substitution report returns in X-Segments.",
      code: [
        `curl -X POST "${base}/v1/speak" \\`,
        `  -H "xi-api-key: ${KEY_PLACEHOLDER}" -H "Content-Type: application/json" \\`,
        `  -d '{"character_id": "${characterId}",`,
        `       "text": "Hello there. [${emotion}]This is amazing![/${emotion}] Back to baseline."}' \\`,
        `  --output scene.wav`,
      ].join("\n"),
    },
    {
      id: "performance",
      label: "performance",
      hint: "Multi-character script in one call — needs a key with the 'performance' scope. Check GET /v1/characters/{id}/manifest first.",
      code: [
        `curl -X POST "${base}/v1/performance" \\`,
        `  -H "xi-api-key: ${KEY_PLACEHOLDER}" -H "Content-Type: application/json" \\`,
        `  -d '{"lines": [`,
        `    {"character_id": "${characterId}", "text": "[${emotion}]We open at dawn."},`,
        `    {"character_id": "alba", "text": "And the narrator sets the scene."}`,
        `  ]}' --output act1.wav`,
      ].join("\n"),
    },
  ];
}

export default function ApiPanel({ characterId, filledEmotions }: { characterId: string; filledEmotions: string[] }) {
  const recipes = useMemo(() => buildRecipes(characterId, filledEmotions), [characterId, filledEmotions]);
  const [active, setActive] = useState(recipes[0].id);
  const [copied, setCopied] = useState(false);
  const recipe = recipes.find((r) => r.id === active) ?? recipes[0];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recipe.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* selectable anyway */ }
  };

  return (
    <div className="glass-panel mt-8 rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          use this character via api
        </span>
        <div className="flex gap-1.5">
          {recipes.map((r) => (
            <button
              key={r.id} onClick={() => { setActive(r.id); setCopied(false); }}
              className={`font-jetbrains cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition ${
                r.id === active ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[13px] text-white/60">{recipe.hint}</p>
      <pre className="font-jetbrains mt-3 overflow-x-auto rounded-xl border border-white/8 bg-black/40 p-4 text-[12px] leading-relaxed text-cyan-100/90">
        {recipe.code}
      </pre>
      <button onClick={copy}
        className="font-jetbrains mt-3 cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/85 transition hover:bg-white/5">
        {copied ? "✓ copied" : "copy"}
      </button>
    </div>
  );
}
