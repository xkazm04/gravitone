"use client";

// THE CHARACTER RAIL — who is speaking, and the overflow panel that makes every
// Character reachable in Solo mode. It owns its own open/filter/roving-focus
// state because nothing else on the page reads any of it.

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Character } from "@/app/voices/_data/characters";

// How many Characters the rail shows before it has to be expanded. The density
// is deliberate — the overflow is a panel, not a wall of buttons.
const RAIL_PREVIEW = 10;

export function PlaygroundCharacterRail({ characters, charId, onSelect, preferred }: {
  characters: Character[];
  charId: string;
  onSelect: (id: string) => void;
  preferred: { character_id: string | null; picks: number };
}) {
  // The character rail showed the first ten Characters and stopped, with no
  // affordance at all — clone an eleventh voice and it was simply unreachable
  // in Solo mode, while Script mode's <select> listed every one of them. Same
  // data, two truths. The rail keeps its density (ten, then a scrollable panel)
  // and gains a filter once the roster is big enough to need one.
  const [railOpen, setRailOpen] = useState(false);
  const [railQuery, setRailQuery] = useState("");
  // Keyed by character_id, NOT by position in the filtered list.
  //
  // As a position-indexed array this was never compacted (the way lineRefs has
  // to be), so a filter left entries past the visible count pointing at
  // unmounted buttons. That is not reachable TODAY — the inline ref callback is
  // a new closure every render, so React re-attaches every visible index, and a
  // test that filters the rail and arrows across it passes either way (checked).
  // It is one memoised callback away from being reachable, and the correctness
  // of roving focus should not rest on that. An id cannot drift from the list
  // it keys.
  const railRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Which Characters the rail draws. Collapsed it shows RAIL_PREVIEW, but never
  // hides the selected one — a selection you cannot see is how "nothing is
  // selected" gets misread.
  const railMatches = useMemo(() => {
    const q = railQuery.trim().toLowerCase();
    if (!q) return characters;
    return characters.filter((c) => c.name.toLowerCase().includes(q) || c.character_id.toLowerCase().includes(q));
  }, [characters, railQuery]);
  const railVisible = useMemo(() => {
    if (railOpen) return railMatches;
    const head = railMatches.slice(0, RAIL_PREVIEW);
    const sel = railMatches.find((c) => c.character_id === charId);
    return sel && !head.includes(sel) ? [sel, ...head.slice(0, RAIL_PREVIEW - 1)] : head;
  }, [railMatches, railOpen, charId]);
  const railHidden = railMatches.length - railVisible.length;

  /** Roving-tabindex arrow navigation across the rail. Only the pressed button
   *  is in the tab order; arrows move focus within the group (Enter/Space still
   *  does the selecting, so focus never changes the voice by accident). */
  function onRailKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = railVisible.length - 1;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (i === last ? 0 : i + 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i === 0 ? last : i - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : -1;
    if (to < 0) return;
    e.preventDefault();
    const target = railVisible[to];
    if (target) railRefs.current.get(target.character_id)?.focus();
  }

  return (
    <div className="mt-8">
      <div className="font-jetbrains mb-2 flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-widest text-white/60">
        <span>character</span>
        {preferred.character_id && preferred.picks > 0 && (
          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/5 px-2 py-0.5 normal-case tracking-normal text-emerald-200/90">
            ✓ client-approved default · {preferred.picks} pick{preferred.picks > 1 ? "s" : ""}
          </span>
        )}
      </div>
      {railOpen && characters.length > RAIL_PREVIEW && (
        <input
          value={railQuery}
          onChange={(e) => setRailQuery(e.target.value)}
          placeholder="Filter characters…"
          aria-label="Filter characters"
          className="font-jetbrains mb-2 w-full max-w-xs rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-[12px] text-white/85 placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none"
        />
      )}
      <div
        role="group"
        aria-label="Character"
        className={`flex flex-wrap gap-2 ${railOpen ? "max-h-64 overflow-y-auto pr-1" : ""}`}
      >
        {railVisible.map((c, i) => {
          const on = c.character_id === charId;
          return (
            <button key={c.character_id} onClick={() => onSelect(c.character_id)} aria-pressed={on}
              ref={(el) => {
                if (el) railRefs.current.set(c.character_id, el);
                else railRefs.current.delete(c.character_id);
              }}
              onKeyDown={(e) => onRailKey(e, i)}
              tabIndex={on || (!charId && i === 0) ? 0 : -1}
              className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition ${on ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/10 hover:border-white/25"}`}>
              <span className="h-6 w-6 rounded-full" style={{ background: `radial-gradient(circle at 30% 30%, hsl(${(c.character_id.length * 47) % 360} 90% 70%), hsl(${(c.character_id.length * 47) % 360} 80% 45%))` }} />
              <span>
                <span className="block text-sm text-white">{c.name}</span>
                <span className="font-jetbrains text-[11px] text-white/60">{c.category} · {c.coverage}/{c.total} emotions</span>
              </span>
            </button>
          );
        })}
        {railHidden > 0 && (
          <button
            onClick={() => setRailOpen(true)}
            aria-expanded={false}
            title="Show every Character — Script mode already lists them all"
            className="font-jetbrains rounded-xl border border-dashed border-white/15 px-3 py-2 text-[11px] text-white/65 transition hover:border-cyan-400/40 hover:text-cyan-200"
          >
            +{railHidden} more
          </button>
        )}
        {railOpen && (
          <button
            onClick={() => { setRailOpen(false); setRailQuery(""); }}
            aria-expanded
            className="font-jetbrains rounded-xl border border-dashed border-white/15 px-3 py-2 text-[11px] text-white/65 transition hover:border-white/35"
          >
            show fewer
          </button>
        )}
      </div>
      {railOpen && railMatches.length === 0 && (
        <p className="font-jetbrains mt-2 text-[11px] text-white/55">
          No Character matches “{railQuery}”.
        </p>
      )}
    </div>
  );
}
