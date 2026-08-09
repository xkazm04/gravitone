"use client";

import { useEffect, useState } from "react";

// The prototype-round harness (see .claude/skills/prototype): directional
// variants behind a switcher, the chosen tab persisted per module so a reload
// mid-review keeps the reviewer where they were. Deleted when the module
// consolidates — this file exists only while a round is open.

export type PrototypeVariant = {
  id: string;
  label: string;
  sub?: string;
  node: React.ReactNode;
};

export default function PrototypeTabs({
  storageKey,
  variants,
}: {
  storageKey: string;
  variants: PrototypeVariant[];
}) {
  const [active, setActive] = useState(variants[0]?.id ?? "");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved && variants.some((v) => v.id === saved)) setActive(saved);
    } catch {
      /* storage refused — the default tab is fine */
    }
    setHydrated(true);
  }, [storageKey, variants]);

  const pick = (id: string) => {
    setActive(id);
    try {
      window.localStorage.setItem(storageKey, id);
    } catch {
      /* storage refused — the choice just won't survive a reload */
    }
  };

  const current = variants.find((v) => v.id === active) ?? variants[0];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-2" role="tablist" aria-label="Prototype variants">
        {variants.map((v) => {
          const on = v.id === current?.id;
          return (
            <button
              key={v.id}
              role="tab"
              aria-selected={on}
              onClick={() => pick(v.id)}
              className={`font-jetbrains cursor-pointer rounded-full border px-4 py-1.5 text-[12px] uppercase tracking-[0.14em] transition ${
                on
                  ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-200"
                  : "border-white/10 text-white/55 hover:border-white/25 hover:text-white"
              }`}
            >
              {v.label}
              {v.sub ? <span className="ml-2 normal-case tracking-normal text-white/40">{v.sub}</span> : null}
            </button>
          );
        })}
      </div>
      {/* render only the chosen variant; both mounted would double-poll jobs */}
      <div key={current?.id}>{hydrated ? current?.node : null}</div>
    </div>
  );
}
