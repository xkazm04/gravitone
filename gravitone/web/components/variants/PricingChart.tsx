"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, INK } from "@/components/ui/tokens";
import { useStillMotion } from "@/lib/useStillMotion";
import {
  CHARS_PER_AUDIO_MINUTE,
  elTierFor,
  fmtUsd,
} from "@/lib/switchkit";
import {
  CHART_MAX_CHARS,
  CHART_MIN_CHARS,
  LARGE_BOX,
  SMALL_BOX,
  crossovers,
  fmtChars,
  milestones,
  pricingSeries,
} from "./pricingSeries";

/*
 * The recharts half of the pricing section, in its own module so `next/dynamic`
 * can keep recharts OUT of the landing page's initial chunk. The chart is the
 * section's argument, not its content: the legend, the honesty copy, the price
 * attribution and the table view all render without it (and without JavaScript),
 * so a visitor who never reaches this band never pays for a chart library.
 *
 * Chrome is stripped to the bone on purpose. The studio's language is glass and
 * hairlines; recharts' defaults — boxed axes, tick marks, a bordered tooltip,
 * a legend chip row — fight it. What is left is three 2px strokes, a horizontal
 * hairline grid one step off the surface, and two washes marking the only thing
 * a reader has to take away.
 *
 * BOTH AXES ARE LOGARITHMIC, and both say so. Volume spans 30k to 20M
 * characters and cost spans $5 to $2,400; on linear axes the entire comparison
 * — including the crossover where an always-on box is the WORSE deal — collapses
 * into the bottom-left corner and the chart tells only the flattering half of
 * the story. An unannounced log axis is its own dishonesty, so the axis labels
 * carry it.
 *
 * Nothing here computes a price. ./pricingSeries.ts derives every coordinate
 * from lib/switchkit.ts.
 */

const DATA = pricingSeries();
const TICKS = milestones();
// Only the small box's crossover is marked in the plot. The larger preset's is
// a second vertical rule saying the same thing four decades along, and two
// crossover markers on one chart reads as chrome rather than as the caveat it
// is — the section's honesty strip names both in words.
const [SMALL_CROSS] = crossovers();

// $5 is the lowest plotted price and ~$2,400 the highest; the domain is padded
// to clean decades so the ticks land on 1 / 10 / 100 / 1,000.
const Y_DOMAIN: [number, number] = [1, 4000];
const Y_TICKS = [1, 10, 100, 1000];

const axisTick = { fill: CHART.axisText, fontSize: 11 };

function fmtAxisUsd(v: number): string {
  return v >= 1000 ? `$${(v / 1000).toLocaleString("en-US")}k` : `$${v}`;
}

/** Volume tick: the number a reader can act on, with the tier it names under it. */
function VolumeTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: number } }) {
  const chars = payload?.value ?? 0;
  const tier = TICKS.find((t) => t.charsPerMonth === chars);
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      <text textAnchor="middle" dy={12} fill={CHART.axisText} fontSize={11}>
        {fmtChars(chars)}
      </text>
      {tier ? (
        <text textAnchor="middle" dy={26} fill={CHART.axisText} fontSize={10} opacity={0.7}>
          {tier.name}
        </text>
      ) : null}
    </g>
  );
}

type TipPayload = { payload: { chars: number; el: number; small: number; large: number } };

/** The hover readout. It enhances; it never gates — every value it shows is also
 *  in the legend, the axis or the table view under the chart. */
function Readout({ active, payload }: { active?: boolean; payload?: TipPayload[] }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const tier = elTierFor(p.chars);
  const diff = p.el - p.small;
  return (
    <div className="glass-panel font-jetbrains rounded-xl px-3 py-2.5 text-[11px] leading-relaxed text-white/80">
      <div className="text-white">
        {p.chars.toLocaleString("en-US")} chars/mo
        <span className="text-white/50">
          {" "}
          ≈ {Math.round(p.chars / CHARS_PER_AUDIO_MINUTE).toLocaleString("en-US")} audio-min
        </span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {[
          { c: CHART.el, k: `ElevenLabs · ${tier.name}`, v: p.el },
          { c: CHART.box, k: SMALL_BOX.name, v: p.small },
          { c: CHART.boxLarge, k: LARGE_BOX.name, v: p.large },
        ].map((row) => (
          <li key={row.k} className="flex items-center gap-2">
            <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: row.c }} />
            <span className="text-white/60">{row.k}</span>
            <span className="ml-auto tabular-nums text-white">{fmtUsd(row.v)}</span>
          </li>
        ))}
      </ul>
      {/* Signed, never clamped: below the crossover this reads as a cost. */}
      <div className="mt-1.5 border-t border-white/10 pt-1.5">
        {diff >= 0 ? (
          <span className="text-cyan-200">the box keeps {fmtUsd(diff)}/mo</span>
        ) : (
          <span className="text-amber-200">the box costs {fmtUsd(-diff)}/mo more</span>
        )}
      </div>
    </div>
  );
}

export default function PricingChart() {
  const still = useStillMotion();
  return (
    <div className="h-[300px] w-full sm:h-[380px]">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <LineChart data={DATA} margin={{ top: 8, right: 14, bottom: 26, left: 4 }}>
          {/* Horizontal only: the y decades are what a reader compares against.
              Vertical rules would double the volume ticks and add ink that is
              not data. Solid hairline — a dashed grid reads as "projection". */}
          <CartesianGrid stroke={CHART.grid} strokeWidth={1} vertical={false} />

          {/* The two regions the whole section is about. The amber one is the
              part a pricing page normally hides: an always-on box bills 24/7,
              so under the crossover it is simply the worse deal. */}
          {SMALL_CROSS.chars !== null && (
            <>
              <ReferenceArea
                x1={CHART_MIN_CHARS}
                x2={SMALL_CROSS.chars}
                fill={CHART.warn}
                fillOpacity={0.06}
                label={{ value: "box costs more", position: "insideTop", fill: CHART.warnText, fontSize: 10 }}
              />
              <ReferenceArea
                x1={SMALL_CROSS.chars}
                x2={CHART_MAX_CHARS}
                fill={CHART.box}
                fillOpacity={0.05}
                label={{ value: "box is the cheaper bill", position: "insideTop", fill: CHART.axisText, fontSize: 10 }}
              />
              <ReferenceLine x={SMALL_CROSS.chars} stroke={CHART.warn} strokeOpacity={0.45} strokeWidth={1} />
            </>
          )}

          <XAxis
            dataKey="chars"
            type="number"
            scale="log"
            domain={[CHART_MIN_CHARS, CHART_MAX_CHARS]}
            allowDataOverflow
            ticks={TICKS.map((t) => t.charsPerMonth)}
            // Every milestone, always. recharts' default hides ticks it thinks
            // would collide — which would silently drop the tier a reader came
            // to find. Five ticks across a wide band do not collide; if a
            // narrower breakpoint ever changes that, drop a tick deliberately.
            interval={0}
            tick={<VolumeTick />}
            tickLine={false}
            axisLine={{ stroke: CHART.grid }}
            height={44}
            label={{
              value: "characters / month · log scale",
              position: "insideBottom",
              offset: -18,
              fill: CHART.axisText,
              fontSize: 10,
            }}
          />
          <YAxis
            type="number"
            scale="log"
            domain={Y_DOMAIN}
            ticks={Y_TICKS}
            interval={0}
            tickFormatter={fmtAxisUsd}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={54}
            label={{
              value: "$ / month · log scale",
              angle: -90,
              position: "insideLeft",
              fill: CHART.axisText,
              fontSize: 10,
              style: { textAnchor: "middle" },
            }}
          />

          <Tooltip
            content={<Readout />}
            cursor={{ stroke: CHART.axisText, strokeWidth: 1 }}
            wrapperStyle={{ outline: "none" }}
          />

          {/* Order matters for stacking, not for identity: colour follows the
              entity. The two box lines share a hue because they are the same
              kind of thing; the costlier one is the darker step. */}
          <Line
            dataKey="large"
            name={LARGE_BOX.name}
            stroke={CHART.boxLarge}
            strokeWidth={2}
            strokeLinecap="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: INK }}
            isAnimationActive={!still}
            animationDuration={900}
            animationBegin={160}
          />
          <Line
            dataKey="small"
            name={SMALL_BOX.name}
            stroke={CHART.box}
            strokeWidth={2}
            strokeLinecap="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: INK }}
            isAnimationActive={!still}
            animationDuration={900}
            animationBegin={80}
          />
          <Line
            dataKey="el"
            name="ElevenLabs"
            stroke={CHART.el}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: INK }}
            isAnimationActive={!still}
            animationDuration={900}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
