"use client";

// What the score says in words once a span is chosen, and the standing note
// about substituted emotions when nothing is chosen.

import { clock } from "@/components/ui/Track";
import { emotionMeta } from "@/lib/emotions";
import type { Placed } from "./takeScoreLayout";

export default function TakeScoreReadout({
  chosen,
  selected,
  spans,
  substituted,
}: {
  chosen: Placed | undefined;
  selected: number | null;
  spans: Placed[];
  substituted: number;
}) {
  return (
    <>
      {/* What the selected span actually says. The only thing a click can
          honestly do here, and the thing the ribbon's tooltip hid. */}
      <p aria-live="polite" className="mt-3 min-h-[2.5rem] text-[13px] leading-relaxed text-white/75">
        {chosen ? (
          <>
            <span
              className="font-jetbrains mr-2 rounded-full border px-2 py-0.5 text-[10px]"
              style={{
                borderColor: `hsl(${emotionMeta(chosen.segment.used).hue} 85% 60% / .5)`,
                color: `hsl(${emotionMeta(chosen.segment.used).hue} 85% 78%)`,
              }}
            >
              {chosen.segment.used} · {clock(chosen.start)}–{clock(chosen.end)}
            </span>
            {chosen.segment.character_name && (
              <span className="font-jetbrains mr-2 text-[11px] text-white/55">
                {chosen.segment.character_name}:
              </span>
            )}
            {chosen.segment.text}
            {chosen.segment.fallback && (
              <span className="text-white/45">
                {" "}
                — {chosen.segment.requested} was asked for; this Character has no {chosen.segment.requested} Voice,
                so the nearest one it does have was used.
              </span>
            )}
          </>
        ) : (
          <span className="text-white/45">
            Every coloured span is one emotion the voice switched into mid-take. Select one to read
            the words it covers.
          </span>
        )}
      </p>

      {substituted > 0 && selected === null && (
        <p className="font-jetbrains text-[10px] text-white/35">
          {substituted} of {spans.length} segment{spans.length === 1 ? "" : "s"}{" "}
          {substituted === 1 ? "was" : "were"} substituted — the emotion asked for was not recorded
          for this Character.
        </p>
      )}
    </>
  );
}
