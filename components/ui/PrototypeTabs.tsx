"use client";

import { useEffect, useState } from "react";

export type Variant = { id: string; label: string; sub: string; node: React.ReactNode };

/**
 * Per-module prototyping harness (the /prototype workflow, in-app).
 * Renders 2 directional variants of a module behind a tab strip so we can
 * A/B and prune round-over-round. `storageKey` persists the last pick.
 * When a winner is chosen, delete the losing variant and render it directly.
 */
export default function PrototypeTabs({
  variants,
  storageKey,
}: {
  variants: Variant[];
  storageKey: string;
}) {
  const [active, setActive] = useState(variants[0]?.id);

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved && variants.some((v) => v.id === saved)) setActive(saved);
  }, [storageKey, variants]);

  const pick = (id: string) => {
    setActive(id);
    localStorage.setItem(storageKey, id);
  };

  const current = variants.find((v) => v.id === active) ?? variants[0];

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-center gap-2">
        <span className="font-jetbrains mr-1 text-[11px] uppercase tracking-[0.2em] text-white/35">
          prototype ·
        </span>
        {variants.map((v) => (
          <button
            key={v.id}
            onClick={() => pick(v.id)}
            aria-pressed={active === v.id}
            className={`font-jetbrains rounded-full border px-4 py-2 text-left text-[12px] transition ${
              active === v.id
                ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                : "border-white/10 text-white/55 hover:border-white/20 hover:text-white"
            }`}
          >
            <span className="font-semibold">{v.label}</span>
            <span className="ml-2 opacity-60">{v.sub}</span>
          </button>
        ))}
      </div>
      {current?.node}
    </div>
  );
}
