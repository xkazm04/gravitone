"use client";

// Landing section: what the same monthly volume costs at ElevenLabs, next to
// what one always-on Arm box costs — including the volumes where the box is the
// worse buy.
//
// This replaced a slider and a code snippet. The slider hid the story behind an
// interaction: the shape of the comparison — flat versus a staircase, and the
// one point where they cross — only existed in the reader's head if they dragged
// far enough to see it, and the crossover was the easiest part to drag straight
// past. The chart states it without being asked. The snippet left because it was
// never marketing: it lives where someone with a key can actually use it
// (/keys MigrationKit, /profile), and lib/switchkit.ts::migrationSnippet is
// untouched.

import { useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { motion, useInView } from "framer-motion";
import {
  CHARS_PER_AUDIO_MINUTE,
  ELEVENLABS_PRICING,
  ELEVENLABS_PRICING_NOTE,
  ELEVENLABS_TIERS,
  fmtUsd,
} from "@/lib/switchkit";
import { SWITCH } from "@/lib/content";
import { makeRise } from "@/components/ui/tokens";
import {
  CHART_MAX_CHARS,
  LARGE_BOX,
  SMALL_BOX,
  boxCapacityChars,
  boxMonthlyUsd,
  crossovers,
  fmtChars,
  tableRows,
} from "./pricingSeries";

const rise = makeRise({ y: 24, duration: 0.7, stagger: 0.08 });

// recharts is a separate chunk: the landing must not ship a chart library to
// every visitor for one band most never scroll to. The fallback holds the exact
// box so the swap cannot shift the page under someone mid-read.
const PricingChart = dynamic(() => import("./PricingChart"), {
  ssr: false,
  loading: () => (
    <div className="h-[300px] w-full rounded-2xl border border-white/5 bg-white/[0.015] sm:h-[380px]" />
  ),
});

const FREE_TIER = ELEVENLABS_TIERS[0];
const [SMALL_CROSS, LARGE_CROSS] = crossovers();
const ROWS = tableRows();

/** A legend entry — and the series' direct label, since both box lines are flat
 *  and a flat line's whole value is one number. */
function Key({ colorVar, name, value, note }: { colorVar: string; name: string; value: string; note: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden
        className="mt-[7px] h-0.5 w-5 shrink-0 rounded-full"
        style={{ background: `var(${colorVar})` }}
      />
      <div className="min-w-0">
        <div className="font-jetbrains text-[11px] uppercase tracking-wider text-white/60">{name}</div>
        <div className="font-instrument text-lg leading-tight text-white">{value}</div>
        <div className="font-jetbrains text-[11px] leading-relaxed text-white/45">{note}</div>
      </div>
    </div>
  );
}

export default function PricingSection() {
  // The chart draws itself in when the band arrives, not on page load — an
  // entrance nobody sees is a wasted one, and it also holds the recharts chunk
  // back until the section is genuinely on its way in. `once` because this is an
  // entrance, not a loop (animation austerity: nothing on this page repeats).
  const stage = useRef<HTMLDivElement>(null);
  const armed = useInView(stage, { once: true, margin: "-80px" });

  return (
    <section id="switch" className="border-t border-white/5 py-14">
      <motion.div variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }}>
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">{SWITCH.eyebrow}</span>
        <h2 className="font-instrument mt-2 text-3xl text-white">{SWITCH.headline}</h2>
        <p className="mt-2 max-w-2xl text-sm text-slate-300/80">{SWITCH.sub}</p>
        <p className="font-jetbrains mt-3 text-[11px] uppercase tracking-widest text-white/45">{SWITCH.note}</p>
      </motion.div>

      <motion.div
        ref={stage}
        variants={rise}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-60px" }}
        custom={1}
        className="glass-panel mt-8 rounded-3xl p-5 sm:p-6"
      >
        {/* Legend first, and always — identity never rests on colour-matching,
            and this block renders whether or not the chart chunk ever loads. */}
        <div className="grid gap-4 border-b border-white/5 pb-5 sm:grid-cols-3">
          <Key
            colorVar="--gt-chart-el"
            name="ElevenLabs"
            value="$0 → $1,320/mo"
            note={`published tiers, ${FREE_TIER.name} to ${ELEVENLABS_TIERS[ELEVENLABS_TIERS.length - 1].name} — then per character`}
          />
          <Key
            colorVar="--gt-chart-box"
            name={SMALL_BOX.name}
            value={`${fmtUsd(boxMonthlyUsd(SMALL_BOX))}/mo`}
            note="flat, running 24/7 — the volume does not change it"
          />
          <Key
            colorVar="--gt-chart-box-large"
            name={LARGE_BOX.name}
            value={`${fmtUsd(boxMonthlyUsd(LARGE_BOX))}/mo`}
            note="flat, running 24/7 — for volumes the small box would strain at"
          />
        </div>

        <div className="mt-5">{armed ? <PricingChart /> : <div className="h-[300px] w-full sm:h-[380px]" />}</div>

        {/* THE HONEST HALF. An always-on box bills whether or not it is
            speaking, so under the crossover it is simply the worse buy —
            savingsUsd is deliberately unclamped in lib/switchkit.ts for exactly
            this reason, and a pricing page that only shows the flattering side
            of its own break-even is lying by omission. */}
        {SMALL_CROSS.chars !== null && (
          <p className="font-jetbrains mt-5 rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-[12px] leading-relaxed text-amber-100/85">
            Below ~{SMALL_CROSS.chars.toLocaleString("en-US")} chars/mo
            (≈{Math.round(SMALL_CROSS.chars / CHARS_PER_AUDIO_MINUTE).toLocaleString("en-US")} audio-min)
            an always-on {SMALL_BOX.name} costs MORE than the ElevenLabs tier that covers you — and their{" "}
            {FREE_TIER.name} tier&apos;s first {FREE_TIER.charsPerMonth.toLocaleString("en-US")} chars/mo
            are $0, which no box beats. The box only wins once you use it
            {LARGE_CROSS.chars !== null
              ? `; the ${LARGE_BOX.name} not until ~${LARGE_CROSS.chars.toLocaleString("en-US")} chars/mo`
              : ""}
            .
          </p>
        )}

        <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/45">
          List price against list price: ElevenLabs&apos; published monthly tiers (extrapolated at the top
          tier&apos;s per-character rate beyond it) against one Arm box on on-demand pricing, billed all
          {" "}730 hours of the month. ~{CHARS_PER_AUDIO_MINUTE.toLocaleString("en-US")} chars ≈ one audio
          minute, so the {fmtChars(CHART_MAX_CHARS)} end of the axis is about{" "}
          {Math.round(CHART_MAX_CHARS / CHARS_PER_AUDIO_MINUTE).toLocaleString("en-US")} audio-min — inside
          what a {SMALL_BOX.name} sustains ({Math.round(boxCapacityChars(SMALL_BOX) / CHARS_PER_AUDIO_MINUTE).toLocaleString("en-US")} audio-min/mo at
          its measured {SMALL_BOX.aggregateRtf}× realtime).{" "}
          <Link href="/benchmarks" className="text-cyan-300/80 underline-offset-2 transition hover:text-cyan-200 hover:underline">
            See the measured benchmarks →
          </Link>
        </p>

        {/* The competitor number is the one claim on this page we did not
            measure — it carries its date and its source rather than standing
            alone (lib/content.ts's claims contract sanctions the citation, not
            an assertion). */}
        <p className="font-jetbrains mt-1.5 text-[11px] leading-relaxed text-white/35">
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

        {/* The chart's WCAG-clean twin. A value a reader can only get by hovering
            a 2px line is a value some readers cannot get at all. */}
        <details className="mt-4 border-t border-white/5 pt-4">
          <summary className="font-jetbrains cursor-pointer text-[11px] uppercase tracking-wider text-white/55 transition hover:text-white/80">
            the same numbers as a table
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="font-jetbrains w-full min-w-[30rem] text-left text-[11px] tabular-nums">
              <caption className="sr-only">
                Monthly cost by volume: ElevenLabs list price against two always-on Arm boxes.
              </caption>
              <thead className="text-white/50">
                <tr>
                  <th scope="col" className="py-1.5 pr-3 font-normal">volume / mo</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal">audio-min</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal">ElevenLabs</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal">{SMALL_BOX.name}</th>
                  <th scope="col" className="py-1.5 font-normal">{LARGE_BOX.name}</th>
                </tr>
              </thead>
              <tbody className="text-white/80">
                {ROWS.map((r) => (
                  <tr key={r.tier.name} className="border-t border-white/5">
                    <th scope="row" className="py-1.5 pr-3 font-normal text-white/60">
                      {fmtChars(r.tier.charsPerMonth)} · {r.tier.name}
                    </th>
                    <td className="py-1.5 pr-3">{Math.round(r.audioMinutes).toLocaleString("en-US")}</td>
                    <td className="py-1.5 pr-3">{fmtUsd(r.el)}</td>
                    {/* Cheaper-of-the-row is stated in words, not colour alone. */}
                    <td className="py-1.5 pr-3">
                      {fmtUsd(r.small)}
                      {r.small > r.el && <span className="text-amber-200/80"> (more)</span>}
                    </td>
                    <td className="py-1.5">
                      {fmtUsd(r.large)}
                      {r.large > r.el && <span className="text-amber-200/80"> (more)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </motion.div>
    </section>
  );
}
