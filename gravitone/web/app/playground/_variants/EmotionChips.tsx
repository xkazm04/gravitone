"use client";

// The chip row — the fastest way to direct the words you have selected.
//
// It used to be inlined in the console as a section of its own, under a heading
// of its own, one border-t away from the "direct selection as" row and two away
// from "direct this text". Three containers, three headings, one job: the user
// read three panels where there is one decision. It lives here now so the SAME
// row can be a slot inside the solo composer's one direction panel and the
// scene's, without either copy drifting from the other.
//
// It owns no state and knows nothing about modes: it renders a scale and calls
// `onPick`. Where that lands — the solo score's selection or the active script
// line's — is the console's business (`insertEmotion`).

import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import EmotionIcon from "@/components/ui/EmotionIcon";

/** Baseline is the ABSENCE of a region, not a region worth that name —
 *  `regionProblem` refuses the spelling outright — so its chip is the eraser. */
const CLEARS = "baseline";

export default function EmotionChips({
  scale,
  recorded,
  onPick,
  onOpenWheel,
  disabled = false,
}: {
  /** The Character's palette — base scale plus its custom slots. */
  scale: string[];
  /** What it has actually recorded, for the honest (dashed, dimmed) chip. */
  recorded: string[];
  onPick: (emotion: string) => void;
  /** Open the radial picker. Absent → no wheel button, which is the honest
   *  rendering on a surface that has nowhere to put a modal. */
  onOpenWheel?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          direct the selected words
        </span>
        {onOpenWheel && (
          <button
            type="button"
            onClick={onOpenWheel}
            disabled={disabled}
            className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-400/5 px-3 py-1 text-[11px] text-cyan-200 transition enabled:hover:bg-cyan-400/10 disabled:opacity-40"
          >
            ◎ emotion wheel
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {scale.map((id) => {
          const e = emotionMeta(id);
          const has = recorded.includes(id);
          const custom = !EMOTION_IDS.includes(id);
          const clears = id === CLEARS;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              disabled={disabled}
              // Without this the accessible name used to be the art's alt text
              // followed by the label ("Excited emotion Excited").
              aria-label={clears ? "Clear region" : e.label}
              title={clears
                ? "Clear direction — the selected words go back to this Character's baseline Voice"
                : has ? `${e.label} — available` : `${e.label} — not recorded: the nearest recorded emotion is used, then baseline`}
              className={`font-jetbrains inline-flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[11px] transition disabled:opacity-40 ${
                has ? `border bg-white/5 text-white/85 ${custom ? "border-violet-400/30 enabled:hover:border-violet-400/60" : "border-white/15 enabled:hover:border-cyan-400/40"}`
                    : `border border-dashed text-white/60 ${custom ? "border-violet-400/20" : "border-white/12"}`}`}
            >
              <span className="grid h-5 w-5 place-items-center rounded-full bg-black/40">
                <EmotionIcon emotion={id} size={16} dim={!has} />
              </span>
              {clears ? "Clear region" : e.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
