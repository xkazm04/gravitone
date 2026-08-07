"use client";

// Landing section: what a subscription costs OVER TIME, next to what the same
// two years cost on one always-on Arm box — including the volumes where the box
// is the worse buy.
//
// The band has now shed two things. It shed a slider, because the slider hid the
// story behind an interaction. Then it shed a log-log recharts plot of cost
// against VOLUME, because volume was never the axis the argument lives on: the
// software is free forever and a rented box accrues at a fixed rate, so what a
// subscription DOES is accumulate, and accumulation is a thing that happens in
// months. ./PricingSignal.tsx draws those months in the same illustration
// vocabulary as the eight feature spotlights (features/previews/illus.tsx) —
// which also means the landing no longer ships a chart library to reach it.
//
// The snippet that used to live here left earlier and has not come back: it was
// never marketing, it lives where someone with a key can actually use it (/keys
// MigrationKit, /profile), and lib/switchkit.ts::migrationSnippet is untouched.

import { useRef } from "react";
import Link from "next/link";
import { motion, useInView } from "framer-motion";
import {
  CHARS_PER_AUDIO_MINUTE,
  ELEVENLABS_PRICING,
  ELEVENLABS_PRICING_NOTE,
  ELEVENLABS_TIERS,
  estimateMonthly,
  fmtUsd,
} from "@/lib/switchkit";
import { SWITCH } from "@/lib/content";
import { makeRise } from "@/components/ui/tokens";
import { useStillMotion } from "@/lib/useStillMotion";
import { accentVar } from "./features/previews/illus";
import PricingSignal from "./PricingSignal";
import {
  BELOW_CHARS,
  BELOW_TIER,
  BOX,
  BREAK_EVEN_CHARS,
  HEADLINE_CHARS,
  HEADLINE_TIER,
  TIMELINE_MONTHS,
  fmtChars,
  monthlyPair,
  timelineRows,
} from "./pricingTimeline";

const rise = makeRise({ y: 24, duration: 0.7, stagger: 0.08 });

const FREE_TIER = ELEVENLABS_TIERS[0];
const ROWS = timelineRows();
const HEAD_RATE = monthlyPair(HEADLINE_CHARS);
const BELOW_RATE = monthlyPair(BELOW_CHARS);
const HEAD_ESTIMATE = estimateMonthly(HEADLINE_CHARS, BOX);

const CYAN = accentVar("cyan");
const OTHER = "rgba(255,255,255,0.55)";

/** A legend entry — and each series' direct label, since the drawing is
 *  aria-hidden and identity is never allowed to live in a stroke colour. */
function Key({ color, name, value, note }: { color: string; name: string; value: string; note: string }) {
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
        className="glass-panel mt-8 rounded-3xl p-5 sm:p-6"
      >
        {/* Legend first, and always. The drawing is aria-hidden by construction,
            so this block — plus the table below — is where the series live for
            anyone the picture cannot reach. */}
        <div className="grid gap-4 border-b border-white/5 pb-5 sm:grid-cols-3">
          <Key
            color={CYAN}
            name="Gravitone itself"
            value="$0 / forever"
            note="MIT, self-hosted — the software has no seat and no meter"
          />
          <Key
            color={CYAN}
            name={BOX.name}
            value={`${fmtUsd(HEAD_RATE.box)}/mo`}
            note="flat, running 24/7 — the volume does not change it"
          />
          <Key
            color={OTHER}
            name={`ElevenLabs ${HEADLINE_TIER.name}`}
            value={`${fmtUsd(HEAD_RATE.el)}/mo`}
            note={`the tier that covers ${HEADLINE_CHARS.toLocaleString("en-US")} chars/mo — the volume this comparison assumes`}
          />
        </div>

        {/* The picture. Mounted when the band is on its way in, so the draw
            starts where the reader can see it; the placeholder holds the exact
            box so the swap cannot shift the page under someone mid-read. */}
        <div className="mt-5">
          {armed ? (
            <PricingSignal still={still} />
          ) : (
            <div className="aspect-[680/404] max-h-[404px] w-full rounded-2xl border border-white/5 bg-white/[0.015]" />
          )}
        </div>

        {/* THE HONEST HALF. An always-on box bills whether or not it is
            speaking, so under the crossover it is simply the worse buy —
            savingsUsd is deliberately unclamped in lib/switchkit.ts for exactly
            this reason, and a pricing section that only shows the flattering
            side of its own break-even is lying by omission. The picture draws
            this case at its own scale; the words state it too. */}
        {BREAK_EVEN_CHARS !== null && (
          <p className="font-jetbrains mt-5 rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-[12px] leading-relaxed text-amber-100/85">
            Below ~{BREAK_EVEN_CHARS.toLocaleString("en-US")} chars/mo
            (≈{Math.round(BREAK_EVEN_CHARS / CHARS_PER_AUDIO_MINUTE).toLocaleString("en-US")} audio-min)
            an always-on {BOX.name} costs MORE than the ElevenLabs tier that covers you — at{" "}
            {BELOW_CHARS.toLocaleString("en-US")} chars/mo it is {fmtUsd(BELOW_RATE.box)}/mo against{" "}
            {BELOW_TIER.name}&apos;s {fmtUsd(BELOW_RATE.el)}, and {TIMELINE_MONTHS} months of that never
            turns around. Their {FREE_TIER.name} tier&apos;s first{" "}
            {FREE_TIER.charsPerMonth.toLocaleString("en-US")} chars/mo are $0, which no box beats. The box
            only wins once you use it.
          </p>
        )}

        <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/45">
          List price against list price, over {TIMELINE_MONTHS} months at a fixed{" "}
          {HEADLINE_CHARS.toLocaleString("en-US")} chars/mo: ElevenLabs&apos; published{" "}
          {HEADLINE_TIER.name} tier against one Arm box on on-demand pricing, billed all 730 hours of
          every month. ~{CHARS_PER_AUDIO_MINUTE.toLocaleString("en-US")} chars ≈ one audio minute, so
          that volume is about{" "}
          {Math.round(HEAD_ESTIMATE.audioMinutes).toLocaleString("en-US")} audio-min/mo — well inside
          what a {BOX.name} sustains ({Math.round(HEAD_ESTIMATE.boxCapacityMinutes).toLocaleString("en-US")}{" "}
          audio-min/mo at its measured {BOX.aggregateRtf}× realtime). The software is MIT and costs
          nothing at any volume; the line above the floor is rented hardware, not a licence.{" "}
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

        {/* The drawing's WCAG-clean twin. A value a reader can only get by
            following a 2px stroke is a value some readers cannot get at all. */}
        <details className="mt-4 border-t border-white/5 pt-4">
          <summary className="font-jetbrains cursor-pointer text-[11px] uppercase tracking-wider text-white/55 transition hover:text-white/80">
            the same numbers as a table
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="font-jetbrains w-full min-w-[34rem] text-left text-[11px] tabular-nums">
              <caption className="sr-only">
                Cost by monthly volume: the ElevenLabs tier that covers it against one always-on Arm
                box, for one month and across {TIMELINE_MONTHS} months.
              </caption>
              <thead className="text-white/50">
                <tr>
                  <th scope="col" className="py-1.5 pr-3 font-normal">volume / mo</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal">audio-min</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal">ElevenLabs / mo</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal">{BOX.name} / mo</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal">ElevenLabs · {TIMELINE_MONTHS} mo</th>
                  <th scope="col" className="py-1.5 font-normal">{BOX.name} · {TIMELINE_MONTHS} mo</th>
                </tr>
              </thead>
              <tbody className="text-white/80">
                {ROWS.map((r) => (
                  <tr key={r.tier.name} className="border-t border-white/5">
                    <th scope="row" className="py-1.5 pr-3 font-normal text-white/60">
                      {fmtChars(r.tier.charsPerMonth)} · {r.tier.name}
                    </th>
                    <td className="py-1.5 pr-3">{Math.round(r.audioMinutes).toLocaleString("en-US")}</td>
                    <td className="py-1.5 pr-3">{fmtUsd(r.elMonth)}</td>
                    {/* Losing rows say so in words, not in colour. */}
                    <td className="py-1.5 pr-3">
                      {fmtUsd(r.boxMonth)}
                      {r.boxCostsMore && <span className="text-amber-200/80"> (more)</span>}
                    </td>
                    <td className="py-1.5 pr-3">{fmtUsd(r.elTotal)}</td>
                    <td className="py-1.5">
                      {fmtUsd(r.boxTotal)}
                      {r.boxCostsMore && <span className="text-amber-200/80"> (more)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* The third series in the drawing has no column here because it has
              no variation: it is the same number in every cell. */}
          <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/45">
            Gravitone itself is $0.00 on every row, in every month — MIT, self-hosted. The only cost
            in the {BOX.name} columns is the machine.
          </p>
        </details>
      </motion.div>
    </section>
  );
}
