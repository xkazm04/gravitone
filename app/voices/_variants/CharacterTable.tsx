"use client";

// CHARACTER OVERVIEW — the winning Table direction, now at the Character layer.
// A Character groups Voices across the emotion scale; this table is the roster.
// Drill into a row to work with that Character's individual emotion Voices.

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { EMOTIONS } from "@/lib/emotions";
import TagEditor from "./TagEditor";
import { hueOf, relTime, useCharacters, useVoicePreview, type Character } from "./data";
import { useAuth } from "@/lib/useAuth";
import { CONSENT_PROMPT, recordVoiceOwnership } from "@/lib/voiceVault";

type SortKey = "name" | "category" | "lang" | "coverage" | "created";

function CoverageBar({ c }: { c: Character }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-[2px]">
        {EMOTIONS.map((e) => {
          const on = c.emotions.includes(e.id);
          return (
            <span
              key={e.id}
              title={`${e.label}${on ? "" : " — missing (falls back to baseline)"}`}
              className="h-4 w-1.5 rounded-sm"
              style={{ background: on ? `hsl(${e.hue} 80% 60%)` : "rgba(255,255,255,0.10)" }}
            />
          );
        })}
      </div>
      <span className="font-jetbrains text-[11px] text-white/65">{c.coverage}/{c.total}</span>
    </div>
  );
}

export default function CharacterTable() {
  const { characters, loading, error, createVoice, patchCharacter, deleteCharacter, refresh } = useCharacters();
  const { preview, playingId, busyId } = useVoicePreview();
  const { user } = useAuth();

  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "category", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [bulkTag, setBulkTag] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const packRef = useRef<HTMLInputElement>(null);

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
      : Date.parse(c.created ?? "") || 0;
    return [...f].sort((a, b) => (val(a) > val(b) ? sort.dir : val(a) < val(b) ? -sort.dir : 0));
  }, [characters, query, tagFilter, sort]);

  const clonedSelected = [...selected].filter((id) => characters.find((c) => c.character_id === id)?.category === "cloned");
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.character_id));

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }
  function toggleOne(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  async function applyBulkTag() {
    const t = bulkTag.trim().toLowerCase();
    if (!t) return;
    for (const id of selected) {
      const c = characters.find((x) => x.character_id === id);
      if (c && !c.tags.includes(t)) await patchCharacter(id, { tags: [...c.tags, t] });
    }
    setBulkTag("");
  }
  async function bulkDelete() {
    for (const id of clonedSelected) await deleteCharacter(id);
    setSelected(new Set());
  }
  async function onFile(f: File) {
    if (!window.confirm(CONSENT_PROMPT)) return; // Voice Vault attestation gate
    setCloning(true); setCloneErr(null);
    try {
      const name = f.name.replace(/\.[^.]+$/, "");
      const v = await createVoice(f, name, "baseline", [], f.name);
      if (user) {
        void recordVoiceOwnership(user, [{
          voice_id: v.voice_id, character_id: v.character_id,
          character_name: name, emotion: v.emotion,
        }], "uploaded");
      }
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : "clone failed");
    } finally { setCloning(false); }
  }

  /** Import a .gravichar Character Pack; on an id collision, offer a rename. */
  async function onPack(f: File, rename = "") {
    setImporting(true); setCloneErr(null);
    try {
      const fd = new FormData();
      fd.append("file", f, f.name);
      if (rename) fd.append("rename", rename);
      const r = await fetch("/api/characters/import", { method: "POST", body: fd });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409) {
        const name = window.prompt("A character with this id already exists. Import under a new name:");
        if (name?.trim()) { setImporting(false); return onPack(f, name.trim()); }
        throw new Error(body?.detail ?? "character already exists");
      }
      if (!r.ok) throw new Error(body?.detail ?? `import failed (${r.status})`);
      await refresh();
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : "import failed");
    } finally { setImporting(false); }
  }

  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th className="px-3 py-2 text-left font-normal">
      <button onClick={() => toggleSort(k)} className="font-jetbrains inline-flex items-center gap-1 text-[11px] uppercase tracking-widest text-white/60 transition hover:text-white">
        {children}<span className={sort.key === k ? "text-cyan-300" : "opacity-0"}>{sort.dir === 1 ? "↑" : "↓"}</span>
      </button>
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

      {(error || cloneErr) && (
        <p className="font-jetbrains mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">
          {error ?? cloneErr}
        </p>
      )}

      {/* toolbar */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search characters, tags…"
          className="font-hanken w-72 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/55 focus:border-cyan-400/40 focus:outline-none" />
        <select value={tagFilter ?? ""} onChange={(e) => setTagFilter(e.target.value || null)}
          className="font-jetbrains rounded-lg border border-white/12 bg-[#0d1017] px-3 py-2 text-[12px] text-white/80 focus:outline-none">
          <option value="">all tags</option>
          {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <Link href="/voices/new"
          className="rounded-full bg-gradient-to-r from-cyan-300 to-cyan-200 px-4 py-2 text-[13px] font-semibold text-slate-950 transition hover:brightness-110">
          + New character
        </Link>
        <input ref={packRef} type="file" accept=".gravichar,application/zip" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPack(f); e.target.value = ""; }} />
        <button onClick={() => packRef.current?.click()} disabled={importing}
          title="Import a portable .gravichar Character Pack exported from any Gravitone instance"
          className="font-jetbrains rounded-full border border-white/12 px-3 py-2 text-[12px] text-white/70 transition hover:text-white disabled:opacity-50">
          {importing ? "importing…" : "⇪ import pack"}
        </button>
        <input ref={fileRef} type="file" accept="audio/*,video/mp4" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
        <button onClick={() => fileRef.current?.click()} disabled={cloning}
          className="font-jetbrains rounded-full border border-white/12 px-3 py-2 text-[12px] text-white/70 transition hover:text-white disabled:opacity-50">
          {cloning ? "cloning…" : "quick clone"}
        </button>
        <span className="font-jetbrains ml-auto text-[11px] text-white/60">{rows.length} of {characters.length}</span>
      </div>

      {selected.size > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-4 py-2">
          <span className="font-jetbrains text-[11px] text-cyan-200">{selected.size} selected</span>
          <input value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyBulkTag()}
            placeholder="add tag to all…"
            className="font-jetbrains rounded border border-white/15 bg-transparent px-2 py-1 text-[11px] text-white placeholder:text-white/55 focus:outline-none" />
          <button onClick={applyBulkTag} className="font-jetbrains rounded border border-white/15 px-2 py-1 text-[11px] text-white/80 hover:bg-white/5">apply tag</button>
          <button onClick={bulkDelete} disabled={clonedSelected.length === 0}
            className="font-jetbrains rounded border border-rose-400/30 px-2 py-1 text-[11px] text-rose-300 disabled:opacity-30 hover:bg-rose-400/10">
            delete {clonedSelected.length} cloned
          </button>
          <button onClick={() => setSelected(new Set())} className="font-jetbrains ml-auto text-[11px] text-white/60 hover:text-white">clear</button>
        </div>
      )}

      <div className="glass-panel mt-4 overflow-x-auto rounded-xl">
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
              <th className="px-3 py-2 text-left"><span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">tags</span></th>
              <Th k="created">added</Th>
              <th className="w-28 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="px-3 py-8 text-center text-sm text-white/60">Loading characters…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-sm text-white/60">No characters match.</td></tr>}
            {rows.map((c) => {
              const baseline = c.voices.find((v) => v.emotion === "baseline") ?? c.voices[0];
              return (
                <tr key={c.character_id} className={`border-b border-white/5 transition hover:bg-white/[0.03] ${selected.has(c.character_id) ? "bg-cyan-400/[0.04]" : ""}`}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(c.character_id)} onChange={() => toggleOne(c.character_id)} aria-label={`Select ${c.name}`} className="accent-cyan-400" />
                  </td>
                  <td className="px-2 py-2">
                    <button onClick={() => baseline && preview(baseline.voice_id, c.name)} disabled={!baseline || busyId === baseline?.voice_id}
                      aria-label="Preview baseline" className="grid h-7 w-7 place-items-center rounded-full bg-cyan-300 text-[11px] text-slate-950 transition hover:brightness-110 disabled:opacity-50">
                      {busyId === baseline?.voice_id ? "…" : playingId === baseline?.voice_id ? "⏸" : "▶"}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <span className="h-6 w-6 shrink-0 rounded-full" style={{ background: `radial-gradient(circle at 30% 30%, hsl(${hueOf(c.character_id)} 90% 70%), hsl(${hueOf(c.character_id)} 80% 45%))` }} />
                      {renaming === c.character_id ? (
                        <input autoFocus defaultValue={c.name}
                          onBlur={(e) => { patchCharacter(c.character_id, { name: e.target.value.trim() || c.name }); setRenaming(null); }}
                          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(null); }}
                          className="w-40 rounded border border-cyan-400/40 bg-transparent px-1.5 py-0.5 text-sm text-white focus:outline-none" />
                      ) : (
                        <button onDoubleClick={() => setRenaming(c.character_id)} title="Double-click to rename" className="truncate text-left text-sm font-medium text-white">{c.name}</button>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`font-jetbrains rounded px-1.5 py-0.5 text-[11px] ${c.category === "cloned" ? "bg-cyan-400/10 text-cyan-300" : "bg-white/5 text-white/65"}`}>{c.category}</span>
                  </td>
                  <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{c.lang}</td>
                  <td className="px-3 py-2"><CoverageBar c={c} /></td>
                  <td className="px-3 py-2"><TagEditor compact max={3} tags={c.tags} onChange={(tags) => patchCharacter(c.character_id, { tags })} /></td>
                  <td className="font-jetbrains px-3 py-2 text-[12px] text-white/65">{relTime(c.created)}</td>
                  <td className="px-3 py-2 text-right">
                    <Link href={`/voices/${c.character_id}`} className="font-jetbrains text-[11px] text-cyan-300/80 transition hover:text-cyan-200">open →</Link>
                    {c.category === "cloned" && (
                      <button onClick={() => deleteCharacter(c.character_id)} className="font-jetbrains ml-3 text-[11px] text-white/55 transition hover:text-rose-300">delete</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
