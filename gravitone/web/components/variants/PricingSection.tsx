"use client";

// Landing section: what two years cost when the USAGE GROWS — one always-on Arm
// box against the ElevenLabs tier that covers each month's volume, including the
// months where the box is the worse buy.
//
// The band has now shed four things. It shed a slider, because the slider hid
// the story behind an interaction. Then a log-log recharts plot of cost against
// VOLUME, because volume is not an axis anyone lives on. Then a two-panel
// cumulative miniature, because at a fixed volume there is no crossover to draw.
// And finally its two honesty/assumption PARAGRAPHS: factually right, and
// useless at landing-page reading distance — the facts they carried are now in
// the drawing (the months the machine loses are the thinner slab; the two
// crossings are marked) and in the chip strip, with prose capped by test.
//
// What ships is the prototyping round's variant A, "two bills, counted"
// (./PricingBills.tsx): two odometers counting 24 months — the ElevenLabs
// increment climbing $0 → $330 while the box repeats $12.26 — over a mirrored
// footprint whose ink ratio IS the totals. It marks BOTH truths: month 6, where
// the monthly bills cross, and month 10, where the running totals cross after
// the box repays its five-month debt. Scale-free counters were what beat the
// terrain variant: an honest linear axis compresses the early valley to a
// sliver, and counters do not care.
//
// The snippet that used to live here left earlier and has not come back: it
// lives where someone with a key can actually use it (/keys MigrationKit,
// /profile), and lib/switchkit.ts::migrationSnippet is untouched.

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { SWITCH } from "@/lib/content";
import { makeRise } from "@/components/ui/tokens";
import { useStillMotion } from "@/lib/useStillMotion";
import PricingBills from "./PricingBills";
import {
  AssumptionChips,
  BenchmarksLink,
  CitationLine,
  NumbersTable,
} from "./pricingShared";
import { growthSeries } from "./pricingTimeline";

const rise = makeRise({ y: 24, duration: 0.7, stagger: 0.08 });

const SERIES = growthSeries();

export default function PricingSection() {
  // The illustration draws itself when the band arrives, not on page load — an
  // entrance nobody sees is a wasted one. `once`, because this is an entrance
  // and not a loop (animation austerity: nothing on this page repeats).
  const stage = useRef<HTMLDivElement>(null);
  const armed = useInView(stage, { once: true, margin: "-80px" });
  // Still-aware end to end: reduced motion gets the finished picture, all at
  // once, with nothing dropped (lib/useStillMotion.ts states the rule).
  const still = useStillMotion();

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
        className="glass-panel mt-8 rounded-3xl p-5 sm:p-8"
      >
        <div>
          {armed ? (
            <PricingBills still={still} />
          ) : (
            <div className="aspect-[1160/560] w-full rounded-2xl border border-white/5 bg-white/[0.015]" />
          )}
        </div>

        {/* The assumption and the honest numbers, as chips — the prose form of
            this information is deliberately extinct on this page. The citation
            line and the table are contracts and render for every reader. */}
        <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/5 pt-5">
          <AssumptionChips />
          <BenchmarksLink />
        </div>

        <CitationLine className="mt-1.5" />
        <NumbersTable series={SERIES} className="mt-4" />
      </motion.div>
    </section>
  );
}
