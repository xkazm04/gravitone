"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

type NavLink = { label: string; href: string };

/** Hamburger + glass dropdown for viewports below `md`, where the shells hide
 *  their inline link cluster. Shared by StudioDark (landing) and AppFrame (app
 *  chrome); desktop (md+) never renders it. UserMenu stays alongside untouched. */
export default function MobileNav({ links }: { links: NavLink[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const firstLinkRef = useRef<HTMLAnchorElement>(null);
  const reduce = useReducedMotion();

  // Click outside closes; Escape closes and returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (open) firstLinkRef.current?.focus();
  }, [open]);

  return (
    <div ref={ref} className="relative md:hidden">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls={panelId}
        className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg border border-white/12 text-white/80 transition hover:border-white/25 hover:text-white"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
          {open ? (
            <>
              <path d="M4 4l10 10" />
              <path d="M14 4L4 14" />
            </>
          ) : (
            <>
              <path d="M2.5 5h13" />
              <path d="M2.5 9h13" />
              <path d="M2.5 13h13" />
            </>
          )}
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id={panelId}
            initial={reduce ? false : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: reduce ? 0 : 0.16 }}
            className="glass-panel absolute right-0 top-full z-50 mt-2 w-48 rounded-xl p-2"
          >
            {links.map((l, i) => (
              <Link
                key={l.href}
                ref={i === 0 ? firstLinkRef : undefined}
                href={l.href}
                onClick={() => setOpen(false)}
                className="font-jetbrains block rounded-lg px-3 py-2 text-[13px] text-white/80 transition hover:bg-white/5 hover:text-white"
              >
                {l.label}
              </Link>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
