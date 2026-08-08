"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Wordmark } from "./Primitives";
import SavingsTicker from "./SavingsTicker";
import UserMenu from "./UserMenu";
import MobileNav from "./MobileNav";
import { useAuth } from "@/lib/useAuth";

// The one module list. The landing page's signed-in nav (StudioDark) renders
// this same array — two lists drifted once (the landing never learned /ops
// existed), which is why this is exported rather than copied.
export const MODULES = [
  { label: "Playground", href: "/playground" },
  { label: "Studio", href: "/studio" },
  { label: "Voices", href: "/voices" },
  { label: "API keys", href: "/keys" },
  { label: "Gym", href: "/gym" },
  { label: "Ops", href: "/ops" },
];

/** Obsidian app shell: aurora atmosphere + top nav. Wrap every module route.
 *  Gated: unauthenticated visitors are bounced to the landing page. */
export default function AppFrame({ children }: { children: React.ReactNode }) {
  const { user, loading, authResolved } = useAuth();
  const router = useRouter();

  // Gate on authResolved ("onAuthStateChanged has fired", or config is absent),
  // NOT on `ready` (which only means Firebase config is present). Otherwise a
  // misconfigured deploy leaves `ready` false, collapses every gate, and renders
  // the studio to everyone — a fail-open auth gate.
  useEffect(() => {
    if (authResolved && !loading && !user) router.replace("/");
  }, [authResolved, loading, user, router]);

  const resolving = !authResolved || loading;
  const blocked = authResolved && !loading && !user; // redirecting

  return (
    <div className="font-hanken relative min-h-screen overflow-hidden bg-[var(--gt-ink)] text-slate-200 grain">
      {/* The aurora reads --gt-level / --gt-working (globals.css, filter only),
          so the studio's atmosphere leans into whatever is actually playing or
          rendering. Idle values are the identity filter — same frame as before. */}
      <div className="pointer-events-none absolute inset-0 aurora" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
      <div className="relative mx-auto max-w-6xl px-6">
        <nav className="flex items-center justify-between py-6">
          <Link href="/" aria-label="Gravitone home"><Wordmark /></Link>
          <div className="font-jetbrains hidden items-center gap-7 text-[13px] text-white/70 md:flex">
            {user &&
              MODULES.map((m) => (
                <Link key={m.href} href={m.href} className="transition hover:text-white">
                  {m.label}
                </Link>
              ))}
          </div>
          <div className="flex items-center gap-3">
            <SavingsTicker />
            {user && <MobileNav links={MODULES} />}
            <UserMenu />
          </div>
        </nav>

        {resolving ? (
          <div className="grid min-h-[60vh] place-items-center">
            <span className="font-jetbrains text-[12px] uppercase tracking-widest text-white/50">authenticating…</span>
          </div>
        ) : blocked ? (
          <div className="grid min-h-[60vh] place-items-center">
            <span className="font-jetbrains text-[12px] uppercase tracking-widest text-white/50">redirecting…</span>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
