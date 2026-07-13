"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Wordmark } from "./Primitives";
import SavingsTicker from "./SavingsTicker";
import UserMenu from "./UserMenu";
import MobileNav from "./MobileNav";
import { useAuth } from "@/lib/useAuth";

const MODULES = [
  { label: "Playground", href: "/playground" },
  { label: "Voices", href: "/voices" },
  { label: "API keys", href: "/keys" },
];

/** Obsidian app shell: aurora atmosphere + top nav. Wrap every module route.
 *  Gated: unauthenticated visitors are bounced to the landing page. */
export default function AppFrame({ children }: { children: React.ReactNode }) {
  const { user, loading, ready } = useAuth();
  const router = useRouter();

  // Redirect signed-out users to the landing (only once auth state is known).
  useEffect(() => {
    if (ready && !loading && !user) router.replace("/");
  }, [ready, loading, user, router]);

  const resolving = ready && loading;
  const blocked = ready && !loading && !user; // redirecting

  return (
    <div className="font-hanken relative min-h-screen overflow-hidden bg-[#080a10] text-slate-200 grain">
      <div className="pointer-events-none absolute inset-0 aurora" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
      <div className="relative mx-auto max-w-6xl px-6">
        <nav className="flex items-center justify-between py-6">
          <Link href="/" aria-label="Gravitone home"><Wordmark /></Link>
          <div className="font-jetbrains hidden items-center gap-7 text-[13px] text-white/70 md:flex">
            {(!ready || user) &&
              MODULES.map((m) => (
                <Link key={m.href} href={m.href} className="transition hover:text-white">
                  {m.label}
                </Link>
              ))}
          </div>
          <div className="flex items-center gap-3">
            <SavingsTicker />
            {(!ready || user) && <MobileNav links={MODULES} />}
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
