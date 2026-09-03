"use client";

import type { Recipe } from "../_state/machine";
import type { Take } from "../_state/useAudition";

/** The Audition Room's named alternative: every candidate splice listed with
 *  the backend's own words for it, out from behind the blind comparison. */
export default function VoiceNewTakeList({
  recipes, emotion, chosen, takeOf, hear, playing, onChoose,
}: {
  recipes: Recipe[];
  emotion: string;
  chosen: Recipe | null;
  takeOf: (recipe: Recipe | null) => Take | undefined;
  hear: (recipe: Recipe, slot: string) => Promise<void>;
  playing: string | null;
  onChoose: (recipeId: string | null) => void;
}) {
  return (
    <ul className="mt-3 space-y-2">
      {recipes.map((r) => {
        const t = takeOf(r);
        const isChosen = chosen?.id === r.id;
        return (
          <li key={r.id} className="glass-panel flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5">
            <button
              onClick={() => void hear(r, r.id)}
              disabled={t?.loading}
              aria-label={`${playing === `aud-${emotion}-${r.id}` ? "Pause" : "Play"} the ${r.label} take as a cloned voice`}
              className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110 disabled:opacity-45"
            >
              {t?.loading ? "◌" : playing === `aud-${emotion}-${r.id}` ? "⏸" : "▶"}
            </button>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-[13px] text-white">
                {r.label}
                {r.default && (
                  <span className="font-jetbrains rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-white/60">
                    default
                  </span>
                )}
                <span className="font-jetbrains text-[11px] text-white/45">
                  {r.seconds}s · {r.segments} segment{r.segments === 1 ? "" : "s"}
                </span>
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-white/50">{r.how}</span>
            </span>
            <button
              onClick={() => onChoose(r.default ? null : r.id)}
              aria-pressed={isChosen || (!chosen && Boolean(r.default))}
              className={`font-jetbrains shrink-0 cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] transition ${
                isChosen || (!chosen && r.default)
                  ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                  : "border-white/12 text-white/55 hover:text-white"
              }`}
            >
              {isChosen || (!chosen && r.default) ? "✓ cloning this" : "clone this"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
