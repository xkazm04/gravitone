"use client";

import Link from "next/link";
import { emotionMeta } from "@/lib/emotions";
import { hueOf, relTime, deleteCharacterQuestion, type Character } from "../_data/characters";
import CharacterCoverageBar from "./CharacterCoverageBar";
import TagEditor from "./TagEditor";
import { unmetDemand } from "./characterTableHelpers";

/** One Character in the roster: preview, identity, coverage, demand, tags, actions. */
export default function CharacterRosterRow({
  c, isSelected, toggleOne, preview, playingId, busyId, failedId, failedReason,
  renaming, setRenaming, cancelRename, patchCharacter, deleting, deleteCharacter,
}: {
  c: Character;
  isSelected: boolean;
  toggleOne: (id: string) => void;
  preview: (voiceId: string, label: string, line?: string) => void;
  playingId: string | null;
  busyId: string | null;
  failedId: string | null;
  failedReason: string | null;
  /** The id of the row being renamed — this row compares itself against it. */
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  /** Escape sets this so the unmount's onBlur doesn't commit. */
  cancelRename: { current: boolean };
  patchCharacter: (id: string, patch: { name?: string; tags?: string[] }) => Promise<void>;
  deleting: Set<string>;
  deleteCharacter: (id: string) => Promise<void>;
}) {
  const baseline = c.voices.find((v) => v.emotion === "baseline") ?? c.voices[0];
  // PATCH /v1/characters 409s a built-in, so rename and tag editing
  // were offered, optimistically painted, refused and snapped back.
  // Don't offer what the backend will refuse.
  const editable = c.category === "cloned";
  return (
    <tr className={`border-b border-white/5 transition hover:bg-white/[0.03] ${isSelected ? "bg-cyan-400/[0.04]" : ""}`}>
      <td className="px-3 py-2">
        <input type="checkbox" checked={isSelected} onChange={() => toggleOne(c.character_id)} aria-label={`Select ${c.name}`} className="accent-cyan-400" />
      </td>
      <td className="px-2 py-2">
        {(() => {
          const failed = !!baseline && failedId === baseline.voice_id;
          return (
            <button onClick={() => baseline && preview(baseline.voice_id, c.name)} disabled={!baseline || busyId === baseline?.voice_id}
              aria-label="Preview baseline"
              title={failed ? `Preview failed — ${failedReason ?? "try again"}` : "Preview baseline"}
              className={`grid h-7 w-7 place-items-center rounded-full text-[11px] text-slate-950 transition hover:brightness-110 disabled:opacity-50 ${failed ? "bg-rose-300" : "bg-cyan-300"}`}>
              {busyId === baseline?.voice_id ? "…" : failed ? "!" : playingId === baseline?.voice_id ? "⏸" : "▶"}
            </button>
          );
        })()}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2.5">
          <span className="h-6 w-6 shrink-0 rounded-full" style={{ background: `radial-gradient(circle at 30% 30%, hsl(${hueOf(c.character_id)} 90% 70%), hsl(${hueOf(c.character_id)} 80% 45%))` }} />
          {editable && renaming === c.character_id ? (
            <input autoFocus defaultValue={c.name}
              onBlur={(e) => {
                // Escape unmounts the input, which fires this blur — bail out
                // of committing so "cancel" doesn't save the half-typed name.
                if (cancelRename.current) { cancelRename.current = false; setRenaming(null); return; }
                patchCharacter(c.character_id, { name: e.target.value.trim() || c.name }); setRenaming(null);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { cancelRename.current = true; setRenaming(null); } }}
              className="w-40 rounded border border-cyan-400/40 bg-transparent px-1.5 py-0.5 text-sm text-white focus:outline-none" />
          ) : editable ? (
            <button onDoubleClick={() => setRenaming(c.character_id)} title="Double-click to rename" className="truncate text-left text-sm font-medium text-white">{c.name}</button>
          ) : (
            <span title="Built-in characters ship with the service and cannot be renamed"
              className="truncate text-sm font-medium text-white">{c.name}</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <span className={`font-jetbrains rounded px-1.5 py-0.5 text-[11px] ${c.category === "cloned" ? "bg-cyan-400/10 text-cyan-300" : "bg-white/5 text-white/65"}`}>{c.category}</span>
      </td>
      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{c.lang}</td>
      <td className="px-3 py-2"><CharacterCoverageBar c={c} /></td>
      <td className="px-3 py-2">
        {(() => {
          const { total, hottest } = unmetDemand(c);
          if (total <= 0 || !hottest) return null; // zero-demand → nothing, no layout shift
          return (
            <Link
              href={`/voices/${c.character_id}?record=${encodeURIComponent(hottest)}`}
              title={`API callers requested still-missing emotions ${total}× and got baseline — record ${emotionMeta(hottest).label} next (the hottest gap)`}
              className="font-jetbrains inline-flex items-center gap-1 rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-300 transition hover:bg-amber-400/20"
            >
              ▲ {total} wanted
            </Link>
          );
        })()}
      </td>
      <td className="px-3 py-2">
        {editable ? (
          <TagEditor compact max={3} tags={c.tags} onChange={(tags) => patchCharacter(c.character_id, { tags })} />
        ) : (
          <span title="Built-in characters ship with the service — their tags cannot be edited"
            className="flex flex-wrap items-center gap-1.5">
            {c.tags.slice(0, 3).map((t) => (
              <span key={t} className="font-jetbrains rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/60">{t}</span>
            ))}
            {c.tags.length > 3 && (
              <span className="font-jetbrains rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-white/60">+{c.tags.length - 3}</span>
            )}
            {c.tags.length === 0 && <span className="font-jetbrains text-[11px] text-white/35">—</span>}
          </span>
        )}
      </td>
      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/65">{relTime(c.created)}</td>
      <td className="px-3 py-2 text-right">
        <Link href={`/voices/${c.character_id}`} className="font-jetbrains text-[11px] text-cyan-300/80 transition hover:text-cyan-200">open →</Link>
        {c.category === "cloned" && (
          // Deleting a Character destroys every embedding under it,
          // so it asks first — the same native gate the consent
          // attestation and the import rename already use.
          <button
            onClick={() => { if (window.confirm(deleteCharacterQuestion(c))) void deleteCharacter(c.character_id); }}
            disabled={deleting.has(c.character_id)}
            aria-label={`Delete ${c.name}`}
            className="font-jetbrains ml-3 text-[11px] text-white/55 transition hover:text-rose-300 disabled:opacity-40">
            {deleting.has(c.character_id) ? "deleting…" : "delete"}
          </button>
        )}
      </td>
    </tr>
  );
}
