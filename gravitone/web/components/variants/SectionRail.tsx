"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp } from "lucide-react";
import { useStillMotion } from "@/lib/useStillMotion";

/*
 * The landing page's section nav.
 *
 * The top nav carries route links — and only for signed-in visitors, because
 * AppFrame turns everyone else around at the door. That left a long marketing
 * page with no way to see where you were or to jump to the part you came for.
 * This is that readout: a thin rail parked in the gutter beside the content
 * column, hidden until you have scrolled past the hero, then riding along.
 *
 * It shows for EVERYONE, signed in or out. These are marketing anchors, not app
 * modules — nothing here needs auth to be useful, and MODULES stays the one
 * source of route navigation (AppFrame owns it; this file does not fork it).
 *
 * Every label is legible at rest. A column of bare dots with only the active
 * label pinned is a scroll-position READOUT rather than a nav: you cannot choose
 * a destination you cannot read. Inactive entries sit at 55% — present enough to
 * aim at, quiet enough that the active one still reads as active. Opacity alone
 * carries the state, so nothing reflows as you scroll.
 */

// Section ids as they appear down the page — the order doubles as the scroll-spy
// tiebreak when two sections straddle the viewport midline. The ids are the ones
// already in the markup (and in lib/narratable.ts's anchors); the labels are
// what a visitor is actually looking for.
const SECTIONS = [
  { id: "why", label: "why" },
  { id: "voices", label: "voices" },
  { id: "api", label: "features" },
  { id: "switch", label: "pricing" },
  { id: "playground", label: "playground" },
] as const;

/* Scroll past roughly the hero before the rail appears — the hero column
 * (eyebrow → h1 → sub → CTAs → stats) plus the nav runs ~750px on a laptop, so
 * this reveals the rail on approach to #why rather than over the headline.
 * Cheap and stable; observing the hero instead would fight the section observer
 * below. */
const REVEAL_AT = 600;

/* Scroll position read as an external store rather than mirrored into state by
 * an effect. It is genuinely external (the browser owns it), so this reads the
 * live value on every render — including the first, which matters for a restored
 * scroll position or a deep link into #switch, where an effect-based mirror
 * would paint the rail hidden and then pop it in. */
function subscribeScroll(onChange: () => void): () => void {
  window.addEventListener("scroll", onChange, { passive: true });
  window.addEventListener("resize", onChange);
  return () => {
    window.removeEventListener("scroll", onChange);
    window.removeEventListener("resize", onChange);
  };
}
const isScrolledPastHero = () => window.scrollY > REVEAL_AT;
// The server has no scroll position; the rail starts hidden either way.
const serverSnapshot = () => false;

export default function SectionRail() {
  const still = useStillMotion();
  const shown = useSyncExternalStore(subscribeScroll, isScrolledPastHero, serverSnapshot);
  const [active, setActive] = useState<string | null>(null);
  // Which sections currently cross the viewport's middle band. A Set (not a
  // single id) so a short section handing off to a tall one can't flicker.
  const visible = useRef(new Set<string>());

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (entry.isIntersecting) visible.current.add(id);
          else visible.current.delete(id);
        }
        const first = SECTIONS.find((s) => visible.current.has(s.id));
        setActive(first ? first.id : null);
      },
      // Only the middle 10% band of the viewport counts as "you are here".
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  /*
   * The rail drives the scroll itself rather than leaning on the href: it needs
   * to write the hash too, and `history.replaceState` (not pushState) is the
   * right verb — the rail is a scrubber, not a trail of destinations. Six
   * entries would otherwise bury the page the visitor arrived from under six
   * back-presses. The hash still updates, so the URL stays shareable mid-page,
   * and the plain `href` remains the no-JS fallback.
   *
   * `scroll-behavior: smooth` is global (globals.css) and is already switched
   * off under prefers-reduced-motion by the same file's blanket rule, but
   * scrollIntoView takes the preference explicitly so this does not depend on a
   * CSS cascade three files away.
   */
  const scrollToSection = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id);
    if (!el) return; // Section not on the page — let the browser try the anchor.
    event.preventDefault();
    el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
  };

  return (
    <AnimatePresence>
      {shown ? (
        <motion.nav
          aria-label="Page sections"
          // `y: "-50%"` rather than a `-translate-y-1/2` class: framer writes the
          // whole transform inline, so a Tailwind translate would be clobbered.
          initial={still ? { opacity: 0, y: "-50%" } : { opacity: 0, x: 28, y: "-50%" }}
          animate={{ opacity: 1, x: 0, y: "-50%" }}
          exit={still ? { opacity: 0, y: "-50%" } : { opacity: 0, x: 28, y: "-50%" }}
          transition={still ? { duration: 0.15 } : { duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          /*
           * Parked in the gutter beside the content column, not pinned to the
           * viewport edge. The page is one `max-w-6xl` (72rem) column, so its
           * right edge sits at `50% + 36rem` and the rail can start just past
           * it. Open labels make the rail ~8.75rem wide; the `min()` clamps it
           * back inside the viewport on lg screens too narrow to have that much
           * gutter, where riding the edge is the only option left.
           */
          style={{ left: "min(calc(50% + 36rem + 0.75rem), calc(100% - 9.25rem))" }}
          className="glass-panel fixed top-1/2 z-40 hidden rounded-2xl p-1.5 lg:block"
        >
          <ul className="flex flex-col gap-0.5">
            {SECTIONS.map((s) => {
              const on = active === s.id;
              return (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    onClick={(e) => scrollToSection(e, s.id)}
                    aria-current={on ? "true" : undefined}
                    className={`group/item font-jetbrains flex items-center gap-2 rounded-xl px-2 py-1.5 text-[11px] tracking-[0.14em] transition-colors ${
                      on ? "bg-cyan-400/10 text-cyan-100" : "text-white/80 hover:bg-white/5"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
                        on ? "bg-cyan-300 shadow-[0_0_8px_var(--gt-glow-cyan)]" : "bg-white/30 group-hover/item:bg-cyan-300/60"
                      }`}
                    />
                    <span
                      className={`whitespace-nowrap transition-opacity duration-200 ease-out group-hover/item:opacity-100 ${
                        on ? "opacity-100" : "opacity-55"
                      }`}
                    >
                      {s.label}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" })}
            className="group/item font-jetbrains mt-1 flex w-full cursor-pointer items-center gap-2 rounded-xl border-t border-white/8 px-2 pb-1.5 pt-2 text-[11px] tracking-[0.14em] text-white/80 transition-colors hover:text-cyan-100"
          >
            {/* Sized to the dots above so the labels share one column. */}
            <span aria-hidden className="grid h-1.5 w-1.5 shrink-0 place-items-center">
              <ArrowUp className="h-3 w-3" />
            </span>
            <span className="whitespace-nowrap opacity-55 transition-opacity duration-200 ease-out group-hover/item:opacity-100">
              top
            </span>
          </button>
        </motion.nav>
      ) : null}
    </AnimatePresence>
  );
}
