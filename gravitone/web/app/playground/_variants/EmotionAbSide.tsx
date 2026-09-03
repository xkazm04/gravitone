"use client";

// One half of the comparison: its emotion picker, its play button, and the
// three sentences that keep the tile honest — what it cost, what actually spoke
// it, and whether it was a Gravitone Voice at all.

import EmotionIcon from "@/components/ui/EmotionIcon";
import { emotionMeta } from "@/lib/emotions";
import type { Take } from "./playgroundHelpers";
import { spokenVoice, type AbSide, type Side } from "./emotionCompare";

export default function EmotionAbSide({
  side, s, scale, recorded, characterName, busy, playingId, paused, toggle, onPick,
}: {
  side: AbSide;
  s: Side;
  /** The Character's palette (base scale + its custom slots). */
  scale: string[];
  /** The emotions it has actually RECORDED — the rest fall back. */
  recorded: string[];
  characterName: string;
  busy: boolean;
  playingId: string | null;
  paused: boolean;
  toggle: (t: Take) => void;
  onPick: (side: AbSide, emotion: string) => void;
}) {
  const meta = emotionMeta(s.emotion);
  const isRecorded = recorded.includes(s.emotion);
  const spoken = spokenVoice(s.take);
  const substituted = spoken && spoken.used !== s.emotion;
  const playing = !!s.take && playingId === s.take.id;
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
      <div className="flex items-center gap-2.5">
        <span className="font-jetbrains grid h-6 w-6 place-items-center rounded-full border border-white/15 text-[11px] text-white/70">
          {side}
        </span>
        <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
          <EmotionIcon emotion={s.emotion} size={20} dim={s.state !== "done"} />
        </span>
        <select
          value={s.emotion}
          onChange={(e) => onPick(side, e.target.value)}
          aria-label={`Emotion for side ${side}`}
          disabled={busy}
          className="font-hanken min-w-0 flex-1 rounded-lg border border-white/12 bg-white/[0.03] px-2 py-1.5 text-sm text-white focus:border-cyan-400/40 focus:outline-none disabled:opacity-50"
        >
          {scale.map((e) => (
            <option key={e} value={e} className="bg-slate-900">
              {emotionMeta(e).label}
              {recorded.includes(e) ? "" : " — not recorded"}
            </option>
          ))}
        </select>
        <button
          onClick={() => s.take && toggle(s.take)}
          disabled={!s.take}
          aria-label={playing ? `Pause side ${side}` : `Play side ${side}`}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12px] text-slate-950 transition hover:brightness-110 disabled:opacity-25"
          style={{ background: `hsl(${meta.hue} 85% 64%)` }}
        >
          {playing && !paused ? "⏸" : "▶"}
        </button>
      </div>

      {/* Deliberately not a live region: the console owns the page's
          one status region, and two sides narrating themselves would
          both collide with it and talk over each other. The pair gets a
          single announcement, above. */}
      <p
        className={`font-jetbrains mt-2.5 text-[11px] leading-relaxed ${
          s.state === "failed" ? "text-rose-300"
          : s.state === "rendering" ? "text-cyan-300/80"
          : s.state === "done" ? "text-white/60"
          : "text-white/35"
        }`}
      >
        {s.state === "rendering" ? "rendering…"
          : s.state === "failed" ? s.reason
          : s.state === "done" && s.take
            ? `${s.take.seconds}s · ${s.take.kb} kB`
            : isRecorded ? "not rendered yet"
            : "not recorded — this side will fall back to another Voice"}
      </p>

      {/* What actually spoke it, when that is not what was asked for.
          Amber: nothing broke, but the label on this tile is not the
          whole truth without it. */}
      {substituted && (
        <p className="font-jetbrains mt-1.5 rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-300">
          spoken by {emotionMeta(spoken.used).label} — {characterName} has no{" "}
          {meta.label} recording
        </p>
      )}

      {s.take?.mode === "browser" && (
        <p className="font-jetbrains mt-1.5 rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-300">
          your browser&apos;s voice, not {characterName} — this side says nothing about
          the Voice
        </p>
      )}
    </div>
  );
}
