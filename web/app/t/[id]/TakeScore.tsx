"use client";

// The score of a SHARED take — the same visual language as the studio's editor,
// on the page a visitor lands on.
//
// A share page used to show the performance twice as prose: a waveform that
// knows nothing about the take, and a wrap of chips listing its emotions. What
// it never showed was the SHAPE of the performance — that the whisper is two
// seconds at the start, that the angry stretch is most of the clip, that the
// last line drops back to baseline. That shape is the product's differentiator,
// and the studio already has a grammar for it (<Track> + <Region>), so the share
// page draws the take with the same primitives the editor draws a script with.
//
// It is strictly READ-ONLY: no edges, no drag, no tag writing. A visitor is not
// editing this take, and a control that looks editable and is not would be a
// worse lie than no control at all.
//
// It also claims nothing it cannot do:
//   * no segments (or no duration) -> it renders NOTHING, rather than an empty
//     rail implying a take with no structure;
//   * the player on this page (TakeCard) owns its <audio> privately and exposes
//     no seek seam, so clicking a segment SELECTS it and shows what was said —
//     it does not pretend to move playback;
//   * when the take reports no per-segment seconds, the spans are spaced evenly
//     and say so: that is a picture of the ORDER, not of the timing.

import { useMemo, useState } from "react";
import EmotionArt from "@/components/ui/EmotionArt";
import Region from "@/components/ui/Region";
import Track, { clock } from "@/components/ui/Track";
import { emotionMeta } from "@/lib/emotions";
import type { SharedTake } from "@/lib/takes";

const LANE_HEIGHT = 46;

type Placed = {
  index: number;
  start: number;
  end: number;
  segment: SharedTake["segments"][number];
};

/**
 * Place a shared take's segments on its timeline.
 *
 * Same rule as the console's `segmentRegions`: the reported per-segment seconds
 * are SCALED so the last span ends exactly at the take's stated duration, and a
 * report with no usable seconds falls back to an even division — which is a
 * labelled guess at WHERE each segment is, never a claim about how long it took
 * to say. Kept local (and typed to the SHARE payload, which carries no
 * voice_id/characterId) so the public page does not depend on the playground's
 * take model.
 */
export function placeSegments(
  segments: SharedTake["segments"],
  duration: number,
): { spans: Placed[]; even: boolean } {
  if (segments.length === 0 || !(duration > 0)) return { spans: [], even: false };
  const secs = segments.map((s) => (Number.isFinite(s.seconds) && s.seconds > 0 ? s.seconds : 0));
  const sum = secs.reduce((a, b) => a + b, 0);
  const share = duration / segments.length;
  let at = 0;
  const spans = segments.map((segment, index) => {
    const len = sum > 0 ? (secs[index] / sum) * duration : share;
    const start = at;
    at = index === segments.length - 1 ? duration : Math.min(duration, at + len);
    return { index, start, end: at, segment };
  });
  return { spans, even: sum <= 0 };
}

export default function TakeScore({ take, className = "" }: { take: SharedTake; className?: string }) {
  const [selected, setSelected] = useState<number | null>(null);

  const duration = useMemo(() => {
    const reported = take.segments.reduce((n, s) => n + (s.seconds > 0 ? s.seconds : 0), 0);
    return reported > 0 ? reported : take.seconds;
  }, [take.segments, take.seconds]);

  const { spans, even } = useMemo(
    () => placeSegments(take.segments, duration),
    [take.segments, duration],
  );

  // Absent = invisible: a take published without segment structure gets no
  // empty rail, no placeholder and no explanation nobody asked for.
  if (spans.length === 0) return null;

  const chosen = selected !== null ? spans[selected] : undefined;
  const substituted = take.segments.filter((s) => s.fallback).length;

  return (
    <section aria-label="Performance score" className={`glass-panel mt-4 rounded-2xl p-4 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/50">
          score
        </span>
        <span className="font-jetbrains text-[10px] text-white/40">
          {spans.length} segment{spans.length === 1 ? "" : "s"} · {clock(duration)}
          {even && " · order only, this take reported no per-segment timing"}
        </span>
      </div>

      <div className="mt-3">
        <Track
          label={`Performance score — ${spans.length} emotion segment${spans.length === 1 ? "" : "s"} over ${clock(duration)}`}
          height={LANE_HEIGHT}
          hue={emotionMeta(spans[0].segment.used).hue}
          bars={0}
        >
          {spans.map((s) => {
            const m = emotionMeta(s.segment.used);
            return (
              <Region
                key={s.index}
                start={s.start}
                end={s.end}
                total={duration}
                hue={m.hue}
                label={m.label}
                text={s.segment.text}
                spanText={`${clock(s.start)} to ${clock(s.end)}`}
                index={s.index}
                count={spans.length}
                selected={selected === s.index}
                badge={<EmotionArt emotion={s.segment.used} size={14} />}
                onSelect={() => setSelected((cur) => (cur === s.index ? null : s.index))}
              />
            );
          })}
        </Track>
      </div>

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
    </section>
  );
}
