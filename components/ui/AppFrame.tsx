"use client";

import Link from "next/link";
import { Wordmark } from "./Primitives";
import UserMenu from "./UserMenu";

const MODULES = [
  { label: "Playground", href: "/playground" },
  { label: "Voices", href: "/voices" },
  { label: "API keys", href: "/keys" },
];

/** Obsidian app shell: aurora atmosphere + top nav. Wrap every module route. */
export default function AppFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-hanken relative min-h-screen overflow-hidden bg-[#080a10] text-slate-200 grain">
      <div className="pointer-events-none absolute inset-0 aurora" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
      <div className="relative mx-auto max-w-6xl px-6">
        <nav className="flex items-center justify-between py-6">
          <Link href="/"><Wordmark /></Link>
          <div className="font-jetbrains hidden items-center gap-7 text-[13px] text-white/70 md:flex">
            {MODULES.map((m) => (
              <Link key={m.href} href={m.href} className="transition hover:text-white">
                {m.label}
              </Link>
            ))}
          </div>
          <UserMenu />
        </nav>
        {children}
      </div>
    </div>
  );
}
