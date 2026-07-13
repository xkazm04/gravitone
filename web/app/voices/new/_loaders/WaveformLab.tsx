"use client";

// WAVEFORM LAB — one living SVG-ish waveform is the progress. It reads raw while
// transcribing, calms when isolated, tints per emotion as segments are labelled
// (bars coloured by the live tally), and the headline metric tracks the stage.
// The waveform IS the data, not a spinner beside it.

import { EmotionTally, stateOf, type LoaderData } from "./shared";
import { EMOTIONS } from "@/lib/emotions";

const BARS = 52;

function barColors(counts: Record<string, number> | undefined): string[] {
  if (!counts) return Array(BARS).fill("hsl(190 85% 62%)");
  const present = EMOTIONS.filter((e) => counts[e.id]);
  const total = present.reduce((n, e) => n + counts[e.id], 0) || 1;
  const out: string[] = [];
  present.forEach((e) => {
    const n = Math.round((counts[e.id] / total) * BARS);
    for (let i = 0; i < n; i++) out.push(`hsl(${e.hue} 85% 62%)`);
  });
  while (out.length < BARS) out.push("hsl(190 85% 62%)");
  return out.slice(0, BARS);
}

export default function WaveformLab({ data }: { data: LoaderData }) {
  const p = data.partial;
  const labeling = stateOf(data, "label") !== "pending";
  const stemming = stateOf(data, "stem") !== "pending";
  const colors = barColors(labeling ? p.emotion_counts : undefined);

  // Headline copy comes from the SERVER's own step labels — never fabricated
  // here — so a sovereign scan reads its true local steps ("Detect speech",
  // "Group segments") and never the cloud "Detect emotions" label. Until the
  // first poll delivers steps, show a neutral placeholder.
  const active =
    data.steps.find((s) => s.state === "active") ??
    [...data.steps].reverse().find((s) => s.state === "done");
  const base = data.steps.length === 0 ? "Starting…" : active?.label ?? "Starting…";
  const headline =
    active?.key === "label"
      ? `${base} · ${p.segments_done ?? 0}/${p.segments_total ?? "…"}`
      : active?.key === "transcribe" && p.words
      ? `${base} · ${p.words} words`
      : base;

  // stemming groups the bars into a few clusters (gaps between groups)
  const grouped = stemming;

  return (
    <div>
      <div className="glass-panel rounded-2xl p-6">
        <div className="flex h-28 items-end justify-center gap-[3px]">
          {colors.map((c, i) => (
            <span
              key={i}
              className="eq-bar w-[5px] rounded-full"
              style={{
                height: "100%",
                background: c,
                boxShadow: `0 0 8px ${c}`,
                animationDelay: `${(i % 11) * 0.07}s`,
                animationDuration: `${0.8 + (i % 5) * 0.12}s`,
                marginLeft: grouped && i % 8 === 0 && i > 0 ? "14px" : undefined,
                opacity: labeling ? 1 : 0.85,
              }}
            />
          ))}
        </div>
        <div className="mt-5 text-center">
          <div className="font-jetbrains text-[12px] uppercase tracking-widest text-cyan-300">{headline}</div>
        </div>
      </div>

      {/* live readout */}
      <div className="mt-4 min-h-[52px]">
        {p.emotion_counts ? (
          <EmotionTally counts={p.emotion_counts} />
        ) : p.speakers ? (
          <div className="flex flex-wrap justify-center gap-1.5">
            {p.speakers.map((s) => (
              <span key={s} className="font-jetbrains rounded-full border border-white/12 bg-white/5 px-2.5 py-0.5 text-[10px] text-white/65">{s}</span>
            ))}
          </div>
        ) : null}
        {p.transcript && !p.emotion_counts && (
          <p className="mx-auto mt-3 line-clamp-2 max-w-lg text-center text-[12px] italic text-white/45">“{p.transcript}”</p>
        )}
        {(p.label_errors ?? 0) > 0 && (
          <p className="font-jetbrains mt-3 text-center text-[11px] text-amber-200/70">
            {p.label_errors} segment{p.label_errors === 1 ? "" : "s"} couldn’t be classified — falling back to baseline
          </p>
        )}
      </div>
    </div>
  );
}
