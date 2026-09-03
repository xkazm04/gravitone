"use client";

import Link from "next/link";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import { weakestVoice, type Character } from "../_data/characters";
import SignalChip from "./SignalChip";

export default function CharacterCoverageBar({ c }: { c: Character }) {
  // Pips track this Character's OWN scale (base + its custom slots), so the pip
  // count always matches the "n/total" number even for extended palettes.
  const scale = c.scale?.length ? c.scale : EMOTION_IDS;
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-[2px]">
        {scale.map((id) => {
          const m = emotionMeta(id);
          const on = c.emotions.includes(id);
          return (
            <span
              key={id}
              title={`${m.label}${on ? "" : " — missing (falls back to baseline)"}`}
              className="h-4 w-1.5 rounded-sm"
              style={{ background: on ? `hsl(${m.hue} 80% 60%)` : "rgba(255,255,255,0.10)" }}
            />
          );
        })}
      </div>
      <span className="font-jetbrains text-[11px] text-white/65">{c.coverage}/{c.total}</span>
      {/* WORST-SLOT HINT — coverage says how many voices exist, this says which
          one is the weak one. It is a link, not a badge: the whole point of the
          ledger is that the next action is one click away, and `?record=` is the
          param the guided recorder already opens on. Renders nothing when no
          Voice is flagged (a clean roster, or one measured before the ledger). */}
      {(() => {
        const weakest = weakestVoice(c);
        if (!weakest) return null;
        const label = emotionMeta(weakest.voice.emotion).label;
        return (
          <Link href={`/voices/${c.character_id}?record=${encodeURIComponent(weakest.voice.emotion)}`}
            aria-label={`Re-record the ${label} voice of ${c.name} — ${weakest.signal.label}`}
            className="transition hover:brightness-125">
            <SignalChip signal={weakest.signal} note={`weakest slot: ${label}`} />
          </Link>
        );
      })()}
      {c.category === "cloned" && c.voices.length > 0 && (() => {
        const withReceipt = c.voices.filter((v) => v.consent).length;
        const all = withReceipt === c.voices.length;
        return (
          <span
            title={`${withReceipt} of ${c.voices.length} voice${c.voices.length > 1 ? "s" : ""} carry a consent receipt`}
            className={`font-jetbrains inline-flex items-center gap-0.5 text-[11px] ${all ? "text-emerald-300/90" : withReceipt > 0 ? "text-emerald-300/60" : "text-white/25"}`}
          >
            🛡 {withReceipt}
          </span>
        );
      })()}
    </div>
  );
}
