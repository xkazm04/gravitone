"use client";

import { useState } from "react";

/** Inline tag chips with add/remove. Shared by Gallery + Table variants. */
export default function TagEditor({
  tags,
  onChange,
  compact = false,
  max,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  compact?: boolean;
  max?: number;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const shown = max ? tags.slice(0, max) : tags;
  const overflow = max ? tags.length - shown.length : 0;

  const commit = () => {
    const t = draft.trim().toLowerCase();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((t) => (
        <span
          key={t}
          className={`font-jetbrains group inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/5 text-white/75 ${
            compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]"
          }`}
        >
          {t}
          <button
            onClick={() => onChange(tags.filter((x) => x !== t))}
            aria-label={`Remove tag ${t}`}
            className="text-white/35 transition hover:text-white"
          >
            ×
          </button>
        </span>
      ))}
      {overflow > 0 && (
        <span className="font-jetbrains rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/40">
          +{overflow}
        </span>
      )}

      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setDraft(""); setAdding(false); }
          }}
          placeholder="tag…"
          className={`font-jetbrains w-20 rounded-full border border-cyan-400/40 bg-transparent px-2 text-cyan-200 placeholder:text-white/25 focus:outline-none ${
            compact ? "py-0.5 text-[10px]" : "py-1 text-[11px]"
          }`}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className={`font-jetbrains rounded-full border border-dashed border-white/15 text-white/40 transition hover:border-cyan-400/40 hover:text-cyan-300 ${
            compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]"
          }`}
        >
          + tag
        </button>
      )}
    </div>
  );
}
