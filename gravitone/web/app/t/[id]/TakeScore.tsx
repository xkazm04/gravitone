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
// It is not an EDITOR: no edges, no drag, no tag writing. A visitor is not
// editing this take, and a control that looks editable and is not would be a
// worse lie than no control at all. It is, however, a TRANSPORT — when it is
// handed one.
//
// It claims nothing it cannot do:
//   * no segments (or no duration) -> it renders NOTHING, rather than an empty
//     rail implying a take with no structure;
//   * given a `transport` (the share page hands it the same one the card
//     plays), the rails carry a playhead and seek: clicking a span jumps
//     playback to where that span starts. Without one — the score rendered
//     alone, with no audio behind it — the rails stay inert and a click only
//     SELECTS, because moving a playhead that does not exist is the lie this
//     file exists to avoid;
//   * when the take reports no per-segment seconds, the spans are spaced evenly
//     and say so: that is a picture of the ORDER, not of the timing.

import { useMemo, useState } from "react";
import { characterHue } from "@/app/playground/_variants/shared";
import EmotionIcon from "@/components/ui/EmotionIcon";
import Region from "@/components/ui/Region";
import Track, { clock } from "@/components/ui/Track";
import { emotionMeta } from "@/lib/emotions";
import { castOf, type SharedTake } from "@/lib/takes";

/** What the score needs from the page's transport: where playback is, and a
 *  way to move it. Narrow on purpose — the score plays nothing itself. */
export type ScoreTransport = {
  playing: boolean;
  /** 0..1 through the take. */
  progress: number;
  seekFraction: (fraction: number) => void;
};

const LANE_HEIGHT = 46;
/** Stacked lanes are shorter — a six-hander has to stay one screen. */
const CAST_LANE_HEIGHT = 38;

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

/** The spans one Character speaks, in a stacked-lane score. Absolute time is
 *  kept — a lane is a filtered view of the SAME timeline, so the gaps between
 *  a Character's spans are the moments somebody else was speaking. */
type Lane = { characterId: string; name: string; spans: Placed[] };

/**
 * Split placed spans into one lane per speaker, or a single lane when the take
 * names no cast (a solo take, and every take published before segments carried
 * a speaker).
 *
 * Order is FIRST-SPOKEN, not alphabetical: a scene reads top to bottom in the
 * order its voices enter.
 */
export function laneSegments(spans: Placed[]): Lane[] {
  const lanes: Lane[] = [];
  const at = new Map<string, Lane>();
  for (const span of spans) {
    const id = span.segment.character_id ?? "";
    let lane = at.get(id);
    if (!lane) {
      lane = { characterId: id, name: span.segment.character_name || id, spans: [] };
      at.set(id, lane);
      lanes.push(lane);
    }
    lane.spans.push(span);
  }
  return lanes;
}

/** The timeline the score draws on: the segments' own reported seconds when it
 *  has them, else the take's stated length. */
function scoreDuration(take: SharedTake): number {
  const reported = take.segments.reduce((n, s) => n + (s.seconds > 0 ? s.seconds : 0), 0);
  return reported > 0 ? reported : take.seconds;
}

/** Whether this take has a score to draw at all — the question the share page
 *  asks before deciding whether the card still needs its segment ribbon. */
export function hasScore(take: SharedTake): boolean {
  return placeSegments(take.segments, scoreDuration(take)).spans.length > 0;
}

export default function TakeScore({
  take,
  transport,
  className = "",
}: {
  take: SharedTake;
  /** The page's transport. Absent → the score is a picture, not a control. */
  transport?: ScoreTransport;
  className?: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);

  const duration = useMemo(() => scoreDuration(take), [take]);

  const { spans, even } = useMemo(
    () => placeSegments(take.segments, duration),
    [take.segments, duration],
  );

  // Absent = invisible: a take published without segment structure gets no
  // empty rail, no placeholder and no explanation nobody asked for.
  if (spans.length === 0) return null;

  const chosen = selected !== null ? spans[selected] : undefined;
  const substituted = take.segments.filter((s) => s.fallback).length;
  const cast = castOf(take);
  const lanes = laneSegments(spans);
  // A take with ONE speaker (or none named) draws exactly the rail it always
  // drew — stacking a single lane and labelling it would be ceremony around a
  // fact the header already states.
  const laned = lanes.length > 1;

  // Every lane is a view of the SAME timeline, so each rail carries the same
  // playhead and seeks the same audio. Absent transport → none of it is passed,
  // and <Track> stays a labelled group rather than a slider.
  const rail = transport
    ? {
        progress: transport.progress,
        playing: transport.playing,
        onSeek: transport.seekFraction,
        valueText: (f: number) => `${clock(f * duration)} of ${clock(duration)}`,
      }
    : {};

  /** One span, drawn on whichever rail it belongs to. */
  const region = (s: Placed, count: number) => {
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
        count={count}
        selected={selected === s.index}
        badge={<EmotionIcon emotion={s.segment.used} size={16} />}
        onSelect={() => {
          setSelected((cur) => (cur === s.index ? null : s.index));
          // Selecting a span is also the most direct thing a visitor can mean
          // by clicking it: play from there. Fractions, not seconds — the
          // score's timeline is the take's REPORT, and the audio is the truth.
          if (duration > 0) transport?.seekFraction(s.start / duration);
        }}
      />
    );
  };

  return (
    <section aria-label="Performance score" className={`glass-panel mt-4 rounded-2xl p-4 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/50">
          score
        </span>
        <span className="font-jetbrains text-[10px] text-white/40">
          {laned && `${cast.size} voices · `}
          {spans.length} segment{spans.length === 1 ? "" : "s"} · {clock(duration)}
          {even && " · order only, this take reported no per-segment timing"}
        </span>
      </div>

      {laned ? (
        // ONE LANE PER CHARACTER, over the same timeline: the gaps in a lane
        // are the moments somebody else had the floor, which is what makes a
        // scene legible as a scene. A published ensemble used to arrive here as
        // a single flat rail under the label "Ensemble · N voices" — every
        // span drawn as though one voice said all of it.
        <div className="mt-3 space-y-1.5">
          {lanes.map((lane) => (
            <div key={lane.characterId}>
              <div className="font-jetbrains mb-1 flex items-center gap-1.5 text-[10px] text-white/55">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: `hsl(${characterHue(lane.characterId)} 85% 65%)` }}
                />
                {lane.name}
                <span className="text-white/30">
                  · {lane.spans.length} segment{lane.spans.length === 1 ? "" : "s"}
                </span>
              </div>
              <Track
                label={`${lane.name} — ${lane.spans.length} segment${lane.spans.length === 1 ? "" : "s"} over ${clock(duration)}`}
                height={CAST_LANE_HEIGHT}
                hue={characterHue(lane.characterId)}
                bars={0}
                {...rail}
              >
                {lane.spans.map((s) => region(s, spans.length))}
              </Track>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3">
          <Track
            label={`Performance score — ${spans.length} emotion segment${spans.length === 1 ? "" : "s"} over ${clock(duration)}`}
            height={LANE_HEIGHT}
            hue={emotionMeta(spans[0].segment.used).hue}
            bars={0}
            {...rail}
          >
            {spans.map((s) => region(s, spans.length))}
          </Track>
        </div>
      )}

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
    </section>
  );
}
