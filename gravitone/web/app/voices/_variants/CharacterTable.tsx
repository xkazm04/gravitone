"use client";

// CHARACTER OVERVIEW — the winning Table direction, now at the Character layer.
// A Character groups Voices across the emotion scale; this table is the roster.
// Drill into a row to work with that Character's individual emotion Voices.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useMemo, useRef, useState } from "react";
import { Eyebrow } from "@/components/ui/Primitives";
import { useCharacters, useVoicePreview, weaknessOf, type Character } from "../_data/characters";
import RosterEmpty from "./RosterEmpty";
import CharacterCollisionPrompt from "./CharacterCollisionPrompt";
import CharacterRosterRow from "./CharacterRosterRow";
import CharacterRosterToolbar from "./CharacterRosterToolbar";
import { unmetDemand, type SortKey } from "./characterTableHelpers";
import { useCharacterRosterBulk } from "./useCharacterRosterBulk";
import { useCharacterRosterClone } from "./useCharacterRosterClone";
import { useAuth } from "@/lib/useAuth";
import { useMounted } from "@/lib/useMounted";

export default function CharacterTable() {
  const { characters, loading, error, readFailed, deleting, createVoice, patchCharacter, deleteCharacter, refresh } = useCharacters();
  const { preview, playingId, busyId, failedId, failedReason } = useVoicePreview();
  const { user } = useAuth();
  const mounted = useMounted();

  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "category", dir: 1 });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [cloneErr, setCloneErr] = useState<string | null>(null);
  const cancelRename = useRef(false); // Escape sets this so the unmount's onBlur doesn't commit

  const {
    cloning, collision, setCollision, retryName, setRetryName, vaultWarn, importing, onFile, onPack,
  } = useCharacterRosterClone({ user, createVoice, refresh, setCloneErr });

  const {
    selected, setSelected, clonedSelected, toggleOne,
    bulkTag, setBulkTag, bulkNotice, bulkDeleting, applyBulkTag, bulkDelete,
  } = useCharacterRosterBulk({ characters, refresh, mounted, setCloneErr });

  const allTags = useMemo(() => Array.from(new Set(characters.flatMap((c) => c.tags))).sort(), [characters]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const f = characters.filter(
      (c) =>
        (!q || c.name.toLowerCase().includes(q) || c.character_id.includes(q) || c.tags.some((t) => t.includes(q))) &&
        (!tagFilter || c.tags.includes(tagFilter))
    );
    const val = (c: Character) =>
      sort.key === "name" ? c.name.toLowerCase()
      : sort.key === "category" ? c.category
      : sort.key === "lang" ? c.lang
      : sort.key === "coverage" ? c.coverage
      : sort.key === "weakest" ? weaknessOf(c)
      : sort.key === "demand" ? unmetDemand(c).total
      : Date.parse(c.created ?? "") || 0;
    return [...f].sort((a, b) => (val(a) > val(b) ? sort.dir : val(a) < val(b) ? -sort.dir : 0));
  }, [characters, query, tagFilter, sort]);

  // The read failed AND left nothing on screen — the only case where an empty
  // table body would be a lie rather than a fact.
  const rosterUnavailable = !loading && readFailed && characters.length === 0;
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try { await refresh(); } finally { if (mounted.current) setRetrying(false); }
  };

  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.character_id));

  function toggleSort(key: SortKey) {
    // Demand and weakest open worst-first (desc) — both exist to answer "what
    // should I do next", and that answer is at the top. Everything else ascends.
    setSort((s) => (s.key === key
      ? { key, dir: s.dir === 1 ? -1 : 1 }
      : { key, dir: key === "demand" || key === "weakest" ? -1 : 1 }));
  }

  const SortButton = ({ k, title, children }: { k: SortKey; title?: string; children: React.ReactNode }) => (
    <button onClick={() => toggleSort(k)} title={title}
      className="font-jetbrains inline-flex items-center gap-1 text-[11px] uppercase tracking-widest text-white/60 transition hover:text-white">
      {children}<span className={sort.key === k ? "text-cyan-300" : "opacity-0"}>{sort.dir === 1 ? "↑" : "↓"}</span>
    </button>
  );

  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th className="px-3 py-2 text-left font-normal">
      <SortButton k={k}>{children}</SortButton>
    </th>
  );

  return (
    <div className="pb-24">
      <Eyebrow>character roster</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">Characters.</h1>
      <p className="mt-2 max-w-2xl text-base text-white/70">
        A <span className="text-white">Character</span> is a speaker; each of its{" "}
        <span className="text-white">Voices</span> is one emotion. Missing emotions fall back to baseline.
      </p>

      {(error || cloneErr) && <ErrorBanner>{error ?? cloneErr}</ErrorBanner>}
      {bulkNotice && <ErrorBanner severity="warning">{bulkNotice}</ErrorBanner>}
      {vaultWarn && <ErrorBanner severity="warning">{vaultWarn}</ErrorBanner>}

      {collision && (
        <CharacterCollisionPrompt
          collision={collision} characters={characters}
          retryName={retryName} setRetryName={setRetryName} cloning={cloning}
          onFile={onFile} onDiscard={() => setCollision(null)}
        />
      )}

      {/* toolbar */}
      <CharacterRosterToolbar
        query={query} setQuery={setQuery} tagFilter={tagFilter} setTagFilter={setTagFilter}
        allTags={allTags} importing={importing} cloning={cloning}
        onPack={onPack} onFile={onFile} onClearCollision={() => setCollision(null)}
        shown={rows.length} total={characters.length}
      />

      {selected.size > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-4 py-2">
          <span className="font-jetbrains text-[11px] text-cyan-200">{selected.size} selected</span>
          <input value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyBulkTag()}
            placeholder="add tag to all…"
            className="font-jetbrains rounded border border-white/15 bg-transparent px-2 py-1 text-[11px] text-white placeholder:text-white/55 focus:outline-none" />
          <button onClick={applyBulkTag} className="font-jetbrains rounded border border-white/15 px-2 py-1 text-[11px] text-white/80 hover:bg-white/5">apply tag</button>
          <button onClick={bulkDelete} disabled={clonedSelected.length === 0 || bulkDeleting}
            className="font-jetbrains rounded border border-rose-400/30 px-2 py-1 text-[11px] text-rose-300 disabled:opacity-30 hover:bg-rose-400/10">
            {bulkDeleting ? "deleting…" : `delete ${clonedSelected.length} cloned`}
          </button>
          <button onClick={() => setSelected(new Set())} className="font-jetbrains ml-auto text-[11px] text-white/60 hover:text-white">clear</button>
        </div>
      )}

      <div className="glass-panel mt-4 overflow-x-auto rounded-2xl">
        <table className="w-full min-w-[940px] border-collapse text-sm">
          <thead className="sticky top-0 border-b border-white/8 bg-[#0b0e15]/80 backdrop-blur">
            <tr>
              <th className="w-10 px-3 py-2">
                <input type="checkbox" checked={allShownSelected} onChange={() => setSelected(allShownSelected ? new Set() : new Set(rows.map((r) => r.character_id)))} aria-label="Select all" className="accent-cyan-400" />
              </th>
              <th className="w-10 px-2 py-2" />
              <Th k="name">character</Th>
              <Th k="category">source</Th>
              <Th k="lang">lang</Th>
              <Th k="coverage">emotion coverage</Th>
              {/* `demand` answers "what do my API callers want next"; `weakest`
                  answers "which voice will disappoint them when they get it".
                  They are the two next-action sorts, so they sit together — and
                  the weakest column has no cell of its own on purpose: the hint
                  it ranks is the Signal chip in the coverage bar, where the
                  slot it belongs to is. */}
              <th className="px-3 py-2 text-left font-normal">
                <span className="inline-flex items-center gap-3">
                  <SortButton k="demand">demand</SortButton>
                  <SortButton k="weakest"
                    title="Sort by the weakest measured voice — the Characters with a flagged take first">
                    weakest
                  </SortButton>
                </span>
              </th>
              <th className="px-3 py-2 text-left"><span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">tags</span></th>
              <Th k="created">added</Th>
              <th className="w-28 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-white/60">Loading characters…</td></tr>}
            {/* A failed read is NOT an empty roster. When the read failed and we
                have nothing to show, the table says so (and offers the retry)
                instead of printing "No characters match." under its own error
                banner. A read that failed while a previous roster is still on
                screen keeps showing it — the banner above carries the staleness. */}
            {rosterUnavailable && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-white/60">
                The character roster could not be loaded — this is a failed read, not an empty roster.
                Your characters are untouched.{" "}
                <button onClick={() => void retry()} disabled={retrying}
                  className="font-jetbrains ml-1 text-[12px] text-cyan-300/80 underline underline-offset-2 transition hover:text-cyan-200 disabled:opacity-50">
                  {retrying ? "retrying…" : "retry"}
                </button>
              </td></tr>
            )}
            {/* Two different empty rows. A roster with no characters at all is
                the one place on this page with nothing to compete with, so it
                TEACHES (Signal, full tier): the drawing says what a Character
                is, and the sentence below it — unchanged — stays the caption.
                "No characters match." is a filter result over a roster that
                exists; drawing there would be decoration. */}
            {!loading && !rosterUnavailable && rows.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-10 text-center text-sm text-white/60">
                {characters.length === 0 ? (
                  <RosterEmpty>
                    No characters yet — clone a recording or import a pack to make one.
                  </RosterEmpty>
                ) : (
                  "No characters match."
                )}
              </td></tr>
            )}
            {rows.map((c) => (
              <CharacterRosterRow
                key={c.character_id}
                c={c}
                isSelected={selected.has(c.character_id)}
                toggleOne={toggleOne}
                preview={preview} playingId={playingId} busyId={busyId}
                failedId={failedId} failedReason={failedReason}
                renaming={renaming} setRenaming={setRenaming} cancelRename={cancelRename}
                patchCharacter={patchCharacter}
                deleting={deleting} deleteCharacter={deleteCharacter}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
