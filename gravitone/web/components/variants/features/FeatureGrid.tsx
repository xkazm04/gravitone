"use client";

import { motion } from "framer-motion";
import { FEATURES } from "@/lib/content";
import { makeRise } from "@/components/ui/tokens";
import FeatureCardArt from "./FeatureCardArt";
import { isPreviewKey, type PreviewKey } from "./previews";

/*
 * The eight feature cards.
 *
 * Each is title + two lines of copy over its own watermark, and each opens a
 * live diagram of the mechanism it claims — hover to peek, click or Enter to
 * pin. The spotlight's open/pinned state lives in the PAGE (StudioDark), because
 * the modal renders at the page root while the cards that drive it sit here.
 *
 * The old grid was `sm:grid-cols-2` numbered cards: eight equal blocks of prose
 * with "01".."08" as the only thing distinguishing them. Three columns and a
 * silhouette per card give the eye somewhere to go.
 *
 * NO STICKER TILT. The idea came from a cream neo-brutalist sheet where a
 * per-card rotation reads as paper. On dark glass there is no paper — a card is
 * a 1px hairline over a blur, and rotating it aliases the hairline and shears
 * the backdrop-filter's sample, so it reads as a rendering fault rather than as
 * play. What is left is a restrained lift and the accent hairline coming up: the
 * same "this one is live" signal, in this page's own language.
 *
 * The last card spans two columns. Eight into three leaves a two-card row, and a
 * ragged one looks like a mistake; giving the measured-performance card the
 * extra width fills the row deliberately AND gives the only card carrying
 * numbers room to hold them.
 */

const rise = makeRise({ y: 24, duration: 0.7, stagger: 0.08 });

export default function FeatureGrid({
  preview,
  pinned,
  onHoverOpen,
  onPin,
  onLeave,
}: {
  preview: PreviewKey | null;
  pinned: boolean;
  onHoverOpen: (key: PreviewKey) => void;
  onPin: (key: PreviewKey) => void;
  onLeave: () => void;
}) {
  return (
    <section id="api" className="border-t border-white/5 py-14">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-instrument text-3xl text-white">Eight things it already does.</h2>
        <p className="font-jetbrains text-[11px] uppercase tracking-widest text-white/50">
          hover any card to see the mechanism
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => {
          // The copy and the diagram must be the same claim. A card whose key has
          // no registered preview still renders — it just does not pretend to
          // open one.
          const key = isPreviewKey(f.key) ? f.key : null;
          const open = key !== null && preview === key;
          const last = i === FEATURES.length - 1;
          return (
            <motion.div
              key={f.key}
              {...(key
                ? {
                    role: "button" as const,
                    tabIndex: 0,
                    "aria-haspopup": "dialog" as const,
                    "aria-expanded": open,
                    // React's own enter/leave, not framer's onHoverStart. The
                    // gesture behaviour that matters here is the touch filter,
                    // and it is one line — worth having in the open, next to the
                    // reason for it: on a touchscreen `pointerenter` fires
                    // immediately before the tap's click, so an unfiltered peek
                    // would open and be instantly pinned by the same finger,
                    // and the "hover to peek, tap to pin" split would collapse.
                    onPointerEnter: (e: React.PointerEvent) => {
                      if (e.pointerType === "touch") return;
                      onHoverOpen(key);
                    },
                    onPointerLeave: (e: React.PointerEvent) => {
                      if (e.pointerType === "touch") return;
                      if (!pinned) onLeave();
                    },
                    onFocus: () => onHoverOpen(key),
                    onBlur: () => {
                      if (!pinned) onLeave();
                    },
                    onClick: () => onPin(key),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onPin(key);
                      }
                    },
                  }
                : {})}
              variants={rise}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: "-60px" }}
              // Column stagger, not index stagger: the row arrives as a row.
              custom={i % 3}
              whileHover={{ y: -4 }}
              transition={{ duration: 0.25 }}
              className={`glass-panel group relative cursor-pointer overflow-hidden rounded-2xl p-6 text-left transition-colors hover:border-cyan-400/30 ${
                last ? "lg:col-span-2" : ""
              }`}
            >
              {key && <FeatureCardArt preview={key} />}
              {/* The art is absolutely positioned, so it would paint over
                  statically-positioned text. One positioned wrapper puts the copy
                  back on top without a z-index on every line. */}
              <div className="relative">
                <h3 className="font-instrument text-xl leading-tight text-white">{f.title}</h3>
                <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-300/80">{f.body}</p>
              </div>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
