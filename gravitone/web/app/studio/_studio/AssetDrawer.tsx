"use client";

// The asset detail drawer — preview at the top, honest caption, tags, and
// the provenance chain the user can walk. Scrim + Escape close.

import { useEffect } from "react";
import { X } from "lucide-react";

import type { Asset } from "./types";
import { CaptionBlock, KindGlyph, MockPreview, ProvenanceBlock, fmtBytes, fmtDur } from "./assetParts";

export function AssetDrawer({
  asset,
  onClose,
  onSelect,
}: {
  asset: Asset;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50">
      <button aria-label="Close" className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-white/10 bg-[var(--gt-ink)]/95 backdrop-blur">
        <MockPreview asset={asset} className="h-52 shrink-0" />
        <div className="scroll-y flex-1 space-y-5 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-jetbrains flex items-center gap-2 text-[11px] tracking-[0.14em] text-white/40 uppercase">
                <KindGlyph kind={asset.kind} /> {asset.kind}
                {asset.dims && <span className="normal-case">· {asset.dims}</span>}
                {asset.durationS != null && <span>· {fmtDur(asset.durationS)}</span>}
                <span>· {fmtBytes(asset.bytes)}</span>
              </p>
              <h3 className="font-instrument mt-1.5 text-2xl text-white">{asset.title}</h3>
            </div>
            <button
              onClick={onClose}
              aria-label="Close details"
              className="rounded-lg border border-white/10 p-1.5 text-white/60 transition hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <CaptionBlock asset={asset} />

          <div className="flex flex-wrap gap-1.5">
            {asset.tags.map((t) => (
              <span
                key={t}
                className="font-jetbrains rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-white/60"
              >
                {t}
              </span>
            ))}
            <span className="font-jetbrains rounded-full border border-cyan-400/25 bg-cyan-400/5 px-2 py-0.5 text-[11px] text-cyan-300">
              {asset.collection}
            </span>
          </div>

          <ProvenanceBlock asset={asset} onSelect={onSelect} />
        </div>
      </aside>
    </div>
  );
}
