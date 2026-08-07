"use client";

// Landing section: what two years cost when the USAGE GROWS — one always-on Arm
// box against the ElevenLabs tier that covers each month's volume, including the
// months where the box is the worse buy.
//
// The band has now shed three things. It shed a slider, because the slider hid
// the story behind an interaction. Then it shed a log-log recharts plot of cost
// against VOLUME, because volume is not an axis anyone lives on. Then it shed
// its own two-panel cumulative miniature: at a FIXED monthly volume the winner
// is decided in month one, so there was no crossover to draw and the totals were
// really just a function of the volume we had picked. Growing usage is the
// honest version — the subscription's staircase becomes a consequence of the
// project succeeding, and the crossover becomes a real month.
//
// ./PricingSignal.tsx draws it full width in the same illustration vocabulary as
// the eight feature spotlights (features/previews/illus.tsx) — which also means
// the landing does not ship a chart library to reach it.
//
// The snippet that used to live here left earlier and has not come back: it was
// never marketing, it lives where someone with a key can actually use it (/keys
// MigrationKit, /profile), and lib/switchkit.ts::migrationSnippet is untouched.
//
// PROTOTYPING ROUND (2026-08-07). The band is being redrawn in two directions
// and they live behind the throwaway lens strip below. Everything the contracts
// require — the citation, the legend, the table — is shared (./pricingShared)
// so a variant swaps the PICTURE and nothing else.

import { useRef, useState } from "react";
import Link from "next/link";
import { motion, useInView } from "framer-motion";
import {
  CHARS_PER_AUDIO_MINUTE,
  ELEVENLABS_TIERS,
  estimateMonthly,
  fmtUsd,
} from "@/lib/switchkit";
import { SWITCH } from "@/lib/content";
import { makeRise } from "@/components/ui/tokens";
import { useStillMotion } from "@/lib/useStillMotion";
import { accentVar } from "./features/previews/illus";
import PricingSignal from "./PricingSignal";
import PricingBills from "./PricingBills";
import {
  AssumptionChips,
  BenchmarksLink,
  CitationLine,
  NumbersTable,
  SeriesKey,
} from "./pricingShared";
import {
  BOX,
  BOX_USD_MONTH,
  EL_CHEAPER_THROUGH_CHARS,
  END_CHARS,
  GROWTH_PCT,
  START_CHARS,
  TIMELINE_MONTHS,
  boxUpgradeMonth,
  crossoverMonth,
  growthSeries,
  growthTotals,
} from "./pricingTimeline";

const rise = makeRise({ y: 24, duration: 0.7, stagger: 0.08 });

const FREE_TIER = ELEVENLABS_TIERS[0];
const SERIES = growthSeries();
const TOTALS = growthTotals(SERIES);
const CROSS = crossoverMonth(SERIES);
const UPGRADE = boxUpgradeMonth(SERIES);
const LAST = SERIES[SERIES.length - 1];
/** The last month the subscription is still the cheaper bill, and the first one
 *  it is not — the two rows the honesty copy quotes. */
const LAST_CHEAP = CROSS === null ? LAST : SERIES[CROSS - 2];
const FIRST_COSTLY = CROSS === null ? null : SERIES[CROSS - 1];
/** Headroom at the top of the span, from switchkit's own capacity figure. */
const PEAK = estimateMonthly(END_CHARS, BOX);

const num = (n: number) => n.toLocaleString("en-US");

const CYAN = accentVar("cyan");
const OTHER = "rgba(255,255,255,0.62)";

/* ══════════════════ PROTOTYPING SCAFFOLD — deleted at consolidation ═════════
 *
 * Three lenses on the same numbers. `current` is the default, so nothing about
 * this page changes on load and every existing test still describes what ships.
 * The choice is module-level so it survives a re-render of the section (and a
 * navigation back to it) while comparing — the same shape the feature-spotlight
 * round used (2064c1c).
 */
const LENSES = ["current", "A", "B"] as const;
type Lens = (typeof LENSES)[number];
let chosenLens: Lens = "current";

export default function PricingSection() {
  // The illustration draws itself when the band arrives, not on page load — an
  // entrance nobody sees is a wasted one. `once`, because this is an entrance
  // and not a loop (animation austerity: nothing on this page repeats).
  const stage = useRef<HTMLDivElement>(null);
  const armed = useInView(stage, { once: true, margin: "-80px" });
  // Still-aware end to end: reduced motion gets the finished picture, all at
  // once, with nothing dropped (lib/useStillMotion.ts states the rule).
  const still = useStillMotion();
  const [lens, setLens] = useState<Lens>(chosenLens);

  return (
    <section id="switch" className="border-t border-white/5 py-14">
      <motion.div variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }}>
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">{SWITCH.eyebrow}</span>
        <h2 className="font-instrument mt-2 text-3xl text-white">{SWITCH.headline}</h2>
        <p className="mt-2 max-w-2xl text-sm text-slate-300/80">{SWITCH.sub}</p>
        <p className="font-jetbrains mt-3 text-[11px] uppercase tracking-widest text-white/45">{SWITCH.note}</p>
      </motion.div>

      {/* PROTOTYPING SCAFFOLD — the lens strip. Throwaway. */}
      <div className="mt-4 flex items-center gap-0.5 rounded-full border border-white/10 p-0.5 w-fit">
        {LENSES.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => {
              chosenLens = l;
              setLens(l);
            }}
            aria-pressed={l === lens}
            className={`font-jetbrains cursor-pointer rounded-full px-3 py-1 text-[10px] uppercase tracking-widest transition ${
              l === lens ? "bg-white/10 text-cyan-200" : "text-white/35 hover:text-white/70"
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      <motion.div
        ref={stage}
        variants={rise}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-60px" }}
        custom={1}
        className="glass-panel mt-8 rounded-3xl p-5 sm:p-8"
      >
        {lens === "current" ? (
          <CurrentLens armed={armed} still={still} />
        ) : (
          <VariantLens key={lens} lens={lens} armed={armed} still={still} />
        )}

        <CitationLine className="mt-1.5" />
        <NumbersTable series={SERIES} className="mt-4" />
      </motion.div>
    </section>
  );
}

/* ══════════════════ the lens that ships today ══════════════════════════════ */

function CurrentLens({ armed, still }: { armed: boolean; still: boolean }) {
  return (
    <>
      {/* Legend first, and always. The drawing is aria-hidden by construction,
          so this block — plus the table below — is where the series live for
          anyone the picture cannot reach. */}
      <div className="grid gap-4 border-b border-white/5 pb-6 sm:grid-cols-3">
        <SeriesKey
          color={CYAN}
          name="Gravitone itself"
          value="$0 / forever"
          note="MIT, self-hosted — the software has no seat and no meter"
        />
        <SeriesKey
          color={CYAN}
          name={BOX.name}
          value={`${fmtUsd(BOX_USD_MONTH)}/mo`}
          note="flat, running 24/7 — the volume does not change it"
        />
        <SeriesKey
          color={OTHER}
          name="ElevenLabs tiers"
          value={`${fmtUsd(SERIES[0].el)} → ${fmtUsd(LAST.el)}/mo`}
          note={`whichever published tier covers that month — ${SERIES[0].tier.name} in month 1, ${LAST.tier.name} in month ${TIMELINE_MONTHS}`}
        />
      </div>

      {/* The picture, at the full width of the column. Mounted when the band is
          on its way in, so the draw starts where the reader can see it; the
          placeholder holds the exact box so the swap cannot shift the page
          under someone mid-read. */}
      <div className="mt-6">
        {armed ? (
          <PricingSignal still={still} />
        ) : (
          <div className="aspect-[1160/560] w-full rounded-2xl border border-white/5 bg-white/[0.015]" />
        )}
      </div>

      {/* THE HONEST HALF. An always-on box bills whether or not it is
          speaking, so under the crossover it is simply the worse buy —
          savingsUsd is deliberately unclamped in lib/switchkit.ts for exactly
          this reason, and a pricing section that only shows the flattering
          side of its own break-even is lying by omission. The picture draws
          those months at the same scale as the rest; the words state them. */}
      {EL_CHEAPER_THROUGH_CHARS !== null && FIRST_COSTLY !== null && (
        <p className="font-jetbrains mt-6 rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-[12px] leading-relaxed text-amber-100/85">
          Up to {num(EL_CHEAPER_THROUGH_CHARS)} chars/mo
          (≈{num(Math.round(EL_CHEAPER_THROUGH_CHARS / CHARS_PER_AUDIO_MINUTE))} audio-min)
          an always-on {BOX.name} costs MORE than the ElevenLabs tier that covers you — that is
          months 1–{FIRST_COSTLY.month - 1} of this timeline, where {fmtUsd(BOX_USD_MONTH)}/mo of machine runs
          against {LAST_CHEAP.tier.name}&apos;s {fmtUsd(LAST_CHEAP.el)} at {num(LAST_CHEAP.chars)}{" "}
          chars/mo. Their {FREE_TIER.name} tier&apos;s first {num(FREE_TIER.charsPerMonth)} chars/mo
          are $0, which no box beats. The box only wins once you use it: month {FIRST_COSTLY.month} is where{" "}
          {num(FIRST_COSTLY.chars)} chars/mo lands in {FIRST_COSTLY.tier.name} at{" "}
          {fmtUsd(FIRST_COSTLY.el)} and stays past the machine for good.
        </p>
      )}

      <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/45">
        The assumption, plainly: <span className="text-white/70">one project growing from{" "}
        {num(START_CHARS)} to {num(END_CHARS)} characters a month over {TIMELINE_MONTHS} months</span> —
        the {FREE_TIER.name} tier&apos;s ceiling to the {LAST.tier.name} tier&apos;s ceiling, at the
        same ~{GROWTH_PCT}% growth every month. Each month is priced at whichever ElevenLabs tier
        covers that month&apos;s volume, against one Arm box on on-demand pricing, billed all 730
        hours of every month. ~{num(CHARS_PER_AUDIO_MINUTE)} chars ≈ one audio minute, so month{" "}
        {TIMELINE_MONTHS} is about {num(Math.round(PEAK.audioMinutes))} audio-min —{" "}
        {UPGRADE === null ? (
          <>
            still well inside the {num(Math.round(PEAK.boxCapacityMinutes))} audio-min/mo a{" "}
            {BOX.name} sustains at its measured {BOX.aggregateRtf}× realtime, so the box never has
            to grow across this span
          </>
        ) : (
          <>
            past what one {BOX.name} sustains, so the box steps up to the larger preset in month{" "}
            {UPGRADE} and the drawing carries that riser
          </>
        )}
        . Across the {TIMELINE_MONTHS} months the two run to {fmtUsd(TOTALS.el)} against{" "}
        {fmtUsd(TOTALS.box)}. The software is MIT and costs nothing at any volume; the line above
        the floor is rented hardware, not a licence.{" "}
        <Link href="/benchmarks" className="text-cyan-300/80 underline-offset-2 transition hover:text-cyan-200 hover:underline">
          See the measured benchmarks →
        </Link>
      </p>
    </>
  );
}

/* ══════════════════ the prototype lenses ═══════════════════════════════════ */

/**
 * The variant frame: a picture, then the assumption as chips.
 *
 * The two paragraphs above are GONE here — that is half of what these variants
 * are testing. The facts they carried did not go with them: the months where
 * the machine is the worse buy are drawn (each variant draws them its own way),
 * and the growth assumption, the pricing basis and the capacity headroom are
 * the chip strip. The citation line and the table stay, outside, for every lens.
 */
function VariantLens({ lens, armed, still }: { lens: Lens; armed: boolean; still: boolean }) {
  return (
    <>
      <div>
        {armed ? (
          lens === "A" ? (
            <PricingBills still={still} />
          ) : (
            <PricingClimb still={still} />
          )
        ) : (
          <div className="aspect-[1160/560] w-full rounded-2xl border border-white/5 bg-white/[0.015]" />
        )}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/5 pt-5">
        <AssumptionChips />
        <BenchmarksLink />
      </div>
    </>
  );
}

/* Placeholder until the variant lands in its own commit. */
function PricingClimb({ still }: { still: boolean }) {
  void still;
  return <div className="aspect-[1160/560] w-full rounded-2xl border border-white/5 bg-white/[0.015]" />;
}
