"use client";

/*
 * The parts of the pricing band that are NOT the picture — extracted so the
 * illustration can be swapped without cloning them.
 *
 * Three of these are contracts rather than decoration and every variant of this
 * section renders them unchanged:
 *
 *   <CitationLine>   the one competitor claim on this page carries its date and
 *                    a live link to the source. lib/content.ts's claims rule
 *                    sanctions a CITATION, not an assertion; without this line
 *                    the tier table becomes the latter.
 *   <NumbersTable>   the drawing's WCAG-clean twin. A value a reader can only
 *                    get by following a 2px stroke is a value some readers
 *                    cannot get at all.
 *   <SeriesKey>      identity in words. Every drawing here is aria-hidden, so
 *                    no series may be identified by its stroke colour alone.
 *
 * <AssumptionChips> is the fourth, and the newest: the growth assumption used
 * to be a 90-word paragraph under the chart. Same facts, formatted as key→value
 * rows, because the assumption has to be *read* to do its job and nobody reads
 * the paragraph. It is computed by pricingTimeline::assumptionChips — this file
 * only lays it out.
 */

import Link from "next/link";
import { ELEVENLABS_PRICING, ELEVENLABS_PRICING_NOTE, fmtUsd } from "@/lib/switchkit";
import { EASE } from "@/components/ui/tokens";
import {
  BOX,
  TIMELINE_MONTHS,
  assumptionChips,
  crossoverMonth,
  growthSeries,
  growthTotals,
  type AssumptionChip,
  type GrowthPoint,
} from "./pricingTimeline";

const num = (n: number) => n.toLocaleString("en-US");

/**
 * The TIME at which an eased sweep has reached a given fraction of its path.
 *
 * Both directions mark a specific month on a stroke that draws itself, and a
 * marker placed at the linear fraction of the duration lands nowhere near it:
 * EASE is a strong ease-out, so a fifth of the way through the clock the stroke
 * is already past half the path. This inverts the curve (bisection on the
 * cubic-bezier — exact enough for 24 steps) so a node lands on the month it is
 * naming. Pure, and shared, because two pictures getting this subtly different
 * would be worse than either getting it wrong.
 */
export function easedTimeFor(progress: number): number {
  const [x1, y1, x2, y2] = EASE;
  const bez = (a: number, b: number, t: number) =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bez(y1, y2, mid) < progress) lo = mid;
    else hi = mid;
  }
  return bez(x1, x2, (lo + hi) / 2);
}

/** A legend entry — and each series' direct label, since the drawing is
 *  aria-hidden and identity is never allowed to live in a stroke colour. */
export function SeriesKey({
  color,
  name,
  value,
  note,
}: {
  color: string;
  name: string;
  value: string;
  note: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span aria-hidden className="mt-[7px] h-0.5 w-5 shrink-0 rounded-full" style={{ background: color }} />
      <div className="min-w-0">
        <div className="font-jetbrains text-[11px] uppercase tracking-wider text-white/60">{name}</div>
        <div className="font-instrument text-lg leading-tight text-white">{value}</div>
        <div className="font-jetbrains text-[11px] leading-relaxed text-white/45">{note}</div>
      </div>
    </div>
  );
}

/**
 * The assumption, as a strip of key→value micro-rows.
 *
 * No row is a sentence: each is a label and a figure, so the whole set is
 * scannable in the time a reader actually gives a landing band. The facts are
 * identical to the paragraph this replaced — usage endpoints, the growth rate,
 * the span, how each side is priced, the char↔minute conversion, and the
 * capacity headroom — and they are derived, not retyped.
 */
export function AssumptionChips({
  chips = assumptionChips(),
  className = "",
}: {
  chips?: AssumptionChip[];
  className?: string;
}) {
  return (
    <dl
      className={`font-jetbrains flex flex-wrap gap-x-2 gap-y-2 text-[11px] ${className}`}
      aria-label="the assumptions this comparison rests on"
    >
      {chips.map((c) => (
        <div
          key={c.k}
          className="flex items-baseline gap-2 rounded-full border border-white/8 bg-white/[0.02] px-3 py-1.5"
        >
          <dt className="uppercase tracking-widest text-white/40">{c.k}</dt>
          <dd className="tabular-nums text-white/75">{c.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The one line the competitor numbers may never travel without. */
export function CitationLine({ className = "" }: { className?: string }) {
  return (
    <p className={`font-jetbrains text-[11px] leading-relaxed text-white/35 ${className}`}>
      {ELEVENLABS_PRICING_NOTE} — source:{" "}
      <a
        href={ELEVENLABS_PRICING.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="underline-offset-2 transition hover:text-white/60 hover:underline"
      >
        {ELEVENLABS_PRICING.sourceLabel}
      </a>
    </p>
  );
}

/** The measured link out, kept beside the assumption rather than inside it. */
export function BenchmarksLink({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/benchmarks"
      className={`font-jetbrains text-[11px] text-cyan-300/80 underline-offset-2 transition hover:text-cyan-200 hover:underline ${className}`}
    >
      See the measured benchmarks →
    </Link>
  );
}

/** Every month, every figure, collapsed by default. */
export function NumbersTable({
  series = growthSeries(),
  className = "",
}: {
  series?: GrowthPoint[];
  className?: string;
}) {
  const totals = growthTotals(series);
  const cross = crossoverMonth(series);
  return (
    <details className={`border-t border-white/5 pt-4 ${className}`}>
      <summary className="font-jetbrains cursor-pointer text-[11px] uppercase tracking-wider text-white/55 transition hover:text-white/80">
        the same numbers as a table
      </summary>
      <div className="scroll-y mt-3 max-h-96 overflow-x-auto">
        <table className="font-jetbrains w-full min-w-[34rem] text-left text-[11px] tabular-nums">
          <caption className="sr-only">
            Month by month over {TIMELINE_MONTHS} months: the assumed usage, the ElevenLabs tier that
            covers it and its price, and one always-on {BOX.name}.
          </caption>
          <thead className="text-white/50">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-normal">month</th>
              <th scope="col" className="py-1.5 pr-3 font-normal">chars / mo</th>
              <th scope="col" className="py-1.5 pr-3 font-normal">audio-min</th>
              <th scope="col" className="py-1.5 pr-3 font-normal">ElevenLabs tier</th>
              <th scope="col" className="py-1.5 pr-3 font-normal">ElevenLabs / mo</th>
              <th scope="col" className="py-1.5 font-normal">{BOX.name} / mo</th>
            </tr>
          </thead>
          <tbody className="text-white/80">
            {series.map((p) => (
              <tr key={p.month} className="border-t border-white/5">
                <th scope="row" className="py-1.5 pr-3 font-normal text-white/60">
                  {p.month}
                  {p.month === cross && <span className="text-cyan-300/80"> (they cross)</span>}
                </th>
                <td className="py-1.5 pr-3">{num(p.chars)}</td>
                <td className="py-1.5 pr-3">{num(Math.round(p.audioMinutes))}</td>
                <td className="py-1.5 pr-3">{p.tier.name}</td>
                <td className="py-1.5 pr-3">{fmtUsd(p.el)}</td>
                {/* Losing months say so in words, not in colour. */}
                <td className="py-1.5">
                  {fmtUsd(p.boxUsd)}
                  {p.boxCostsMore && <span className="text-amber-200/80"> (more)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The third series in the drawing has no column here because it has no
          variation: it is the same number in every cell. */}
      <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/45">
        Gravitone itself is $0.00 on every row, in every month — MIT, self-hosted. The only cost in
        the {BOX.name} column is the machine. Over the whole span: {fmtUsd(totals.el)} against{" "}
        {fmtUsd(totals.box)}.
      </p>
    </details>
  );
}
