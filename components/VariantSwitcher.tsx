"use client";

import { useEffect, useState } from "react";
import StudioDark from "./variants/StudioDark";
import Sticker from "./variants/Sticker";
import Silicon from "./variants/Silicon";

const VARIANTS = [
  { id: "a", label: "Obsidian", sub: "cinematic dark", Comp: StudioDark },
  { id: "b", label: "Sticker", sub: "warm brutalist", Comp: Sticker },
  { id: "c", label: "Signal", sub: "silicon scope", Comp: Silicon },
] as const;

export default function VariantSwitcher() {
  const [active, setActive] = useState<string>("a");

  useEffect(() => {
    const saved = localStorage.getItem("gravitone-variant");
    if (saved) setActive(saved);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "1") pick("a");
      if (e.key === "2") pick("b");
      if (e.key === "3") pick("c");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pick = (id: string) => {
    setActive(id);
    localStorage.setItem("gravitone-variant", id);
  };

  const Current = VARIANTS.find((v) => v.id === active)?.Comp ?? StudioDark;

  return (
    <>
      <Current />

      {/* floating switcher */}
      <div className="fixed left-1/2 bottom-5 z-[100] -translate-x-1/2">
        <div
          className="font-jetbrains flex items-center gap-1 rounded-full border border-white/15 bg-black/70 p-1 pr-2 text-[11px] text-white shadow-2xl backdrop-blur-xl"
          role="tablist"
          aria-label="Design variant"
        >
          <span className="px-2 text-white/40">design</span>
          {VARIANTS.map((v, i) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={active === v.id}
              onClick={() => pick(v.id)}
              className={`group relative rounded-full px-3 py-1.5 transition ${
                active === v.id ? "bg-white text-black" : "text-white/70 hover:text-white"
              }`}
            >
              <span className="mr-1 opacity-50">{i + 1}</span>
              {v.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
