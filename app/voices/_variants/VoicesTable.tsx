"use client";

// TABLE — operations metaphor. A dense, sortable, selectable data table built to
// work at scale: search, tag filter, column sort, multi-select with bulk retag /
// bulk delete, inline rename. Same feature set as Gallery, different mental model.

import { useMemo, useRef, useState } from "react";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import TagEditor from "./TagEditor";
import { hueOf, relTime, useVoicePreview, useVoices, type Voice } from "./data";

type SortKey = "name" | "category" | "lang" | "sample" | "created";

export default function VoicesTable() {
  const { voices, loading, error, createVoice, patchVoice, removeVoice } = useVoices();
  const { preview, playingId, busyId } = useVoicePreview();

  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "category", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [bulkTag, setBulkTag] = useState("");
  const [cloning, setCloning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const allTags = useMemo(() => Array.from(new Set(voices.flatMap((v) => v.tags))).sort(), [voices]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const f = voices.filter(
      (v) =>
        (!q || v.name.toLowerCase().includes(q) || v.voice_id.includes(q) || v.tags.some((t) => t.includes(q))) &&
        (!tagFilter || v.tags.includes(tagFilter))
    );
    const val = (v: Voice) =>
      sort.key === "name" ? v.name.toLowerCase()
      : sort.key === "category" ? v.category
      : sort.key === "lang" ? v.lang
      : sort.key === "sample" ? v.sample_seconds ?? -1
      : Date.parse(v.created ?? "") || 0;
    return [...f].sort((a, b) => (val(a) > val(b) ? sort.dir : val(a) < val(b) ? -sort.dir : 0));
  }, [voices, query, tagFilter, sort]);

  const clonedSelected = [...selected].filter((id) => voices.find((v) => v.voice_id === id)?.category === "cloned");
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.voice_id));

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }
  function toggleAll() {
    setSelected(allShownSelected ? new Set() : new Set(rows.map((r) => r.voice_id)));
  }
  function toggleOne(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  async function applyBulkTag() {
    const t = bulkTag.trim().toLowerCase();
    if (!t) return;
    for (const id of selected) {
      const v = voices.find((x) => x.voice_id === id);
      if (v && !v.tags.includes(t)) await patchVoice(id, { tags: [...v.tags, t] });
    }
    setBulkTag("");
  }
  async function bulkDelete() {
    for (const id of clonedSelected) await removeVoice(id);
    setSelected(new Set());
  }
  async function onFile(f: File) {
    const name = f.name.replace(/\.[^.]+$/, "");
    setCloning(true);
    try { await createVoice(f, name, [], f.name); } finally { setCloning(false); }
  }

  const Th = ({ k, children, className = "" }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={`px-3 py-2 text-left font-normal ${className}`}>
      <button onClick={() => toggleSort(k)} className="font-jetbrains inline-flex items-center gap-1 text-[11px] uppercase tracking-widest text-white/40 transition hover:text-white">
        {children}
        <span className={sort.key === k ? "text-cyan-300" : "opacity-0"}>{sort.dir === 1 ? "↑" : "↓"}</span>
      </button>
    </th>
  );

  return (
    <div className="pb-24">
      <Eyebrow>voice library</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">Voice operations.</h1>

      {error && (
        <p className="font-jetbrains mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">
          {error} — start the service or set GRAVITONE_URL.
        </p>
      )}

      {/* toolbar */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <input
          ref={searchRef}
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, id, tag…   (/)"
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          className="font-hanken w-72 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-cyan-400/40 focus:outline-none"
        />
        <select
          value={tagFilter ?? ""} onChange={(e) => setTagFilter(e.target.value || null)}
          className="font-jetbrains rounded-lg border border-white/12 bg-[#0d1017] px-3 py-2 text-[12px] text-white/80 focus:border-cyan-400/40 focus:outline-none"
        >
          <option value="">all tags</option>
          {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        <input ref={fileRef} type="file" accept="audio/*,video/mp4" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
        <Button onClick={() => fileRef.current?.click()} disabled={cloning} className="px-4 py-2 text-[13px]">
          {cloning ? "Cloning…" : "+ Clone from file"}
        </Button>

        <span className="font-jetbrains ml-auto text-[11px] text-white/40">{rows.length} of {voices.length}</span>
      </div>

      {/* bulk bar */}
      {selected.size > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-4 py-2">
          <span className="font-jetbrains text-[11px] text-cyan-200">{selected.size} selected</span>
          <input
            value={bulkTag} onChange={(e) => setBulkTag(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyBulkTag()}
            placeholder="add tag to all…"
            className="font-jetbrains rounded border border-white/15 bg-transparent px-2 py-1 text-[11px] text-white placeholder:text-white/30 focus:outline-none"
          />
          <button onClick={applyBulkTag} className="font-jetbrains rounded border border-white/15 px-2 py-1 text-[11px] text-white/80 hover:bg-white/5">apply tag</button>
          <button onClick={bulkDelete} disabled={clonedSelected.length === 0}
            className="font-jetbrains rounded border border-rose-400/30 px-2 py-1 text-[11px] text-rose-300 disabled:opacity-30 hover:bg-rose-400/10">
            delete {clonedSelected.length} cloned
          </button>
          <button onClick={() => setSelected(new Set())} className="font-jetbrains ml-auto text-[11px] text-white/40 hover:text-white">clear</button>
        </div>
      )}

      {/* table */}
      <div className="glass-panel mt-4 overflow-x-auto rounded-xl">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead className="sticky top-0 border-b border-white/8 bg-[#0b0e15]/80 backdrop-blur">
            <tr>
              <th className="w-10 px-3 py-2">
                <input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Select all" className="accent-cyan-400" />
              </th>
              <th className="w-10 px-2 py-2" />
              <Th k="name">voice</Th>
              <Th k="category">source</Th>
              <Th k="lang">lang</Th>
              <Th k="sample">sample</Th>
              <Th k="created">added</Th>
              <th className="px-3 py-2 text-left"><span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/40">tags</span></th>
              <th className="w-24 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-sm text-white/40">Loading voices…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-sm text-white/40">No voices match.</td></tr>
            )}
            {rows.map((v) => (
              <tr key={v.voice_id} className={`border-b border-white/5 transition hover:bg-white/[0.03] ${selected.has(v.voice_id) ? "bg-cyan-400/[0.04]" : ""}`}>
                <td className="px-3 py-2">
                  <input type="checkbox" checked={selected.has(v.voice_id)} onChange={() => toggleOne(v.voice_id)} aria-label={`Select ${v.name}`} className="accent-cyan-400" />
                </td>
                <td className="px-2 py-2">
                  <button onClick={() => preview(v)} disabled={busyId === v.voice_id}
                    aria-label="Preview" className="grid h-7 w-7 place-items-center rounded-full bg-cyan-300 text-[11px] text-slate-950 transition hover:brightness-110 disabled:opacity-50">
                    {busyId === v.voice_id ? "…" : playingId === v.voice_id ? "⏸" : "▶"}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2.5">
                    <span className="h-6 w-6 shrink-0 rounded-full" style={{ background: `radial-gradient(circle at 30% 30%, hsl(${hueOf(v.voice_id)} 90% 70%), hsl(${hueOf(v.voice_id)} 80% 45%))` }} />
                    {renaming === v.voice_id ? (
                      <input
                        autoFocus defaultValue={v.name}
                        onBlur={(e) => { patchVoice(v.voice_id, { name: e.target.value.trim() || v.name }); setRenaming(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(null); }}
                        className="w-40 rounded border border-cyan-400/40 bg-transparent px-1.5 py-0.5 text-sm text-white focus:outline-none"
                      />
                    ) : (
                      <button onDoubleClick={() => setRenaming(v.voice_id)} title="Double-click to rename"
                        className="truncate text-left text-sm font-medium text-white">
                        {v.name}
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span className={`font-jetbrains rounded px-1.5 py-0.5 text-[10px] ${v.category === "cloned" ? "bg-cyan-400/10 text-cyan-300" : "bg-white/5 text-white/50"}`}>
                    {v.category}
                  </span>
                </td>
                <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{v.lang}</td>
                <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{v.sample_seconds ? `${v.sample_seconds}s` : "—"}</td>
                <td className="font-jetbrains px-3 py-2 text-[12px] text-white/50">{relTime(v.created)}</td>
                <td className="px-3 py-2">
                  <TagEditor compact max={3} tags={v.tags} onChange={(tags) => patchVoice(v.voice_id, { tags })} />
                </td>
                <td className="px-3 py-2 text-right">
                  {v.category === "cloned" ? (
                    <button onClick={() => removeVoice(v.voice_id)} className="font-jetbrains text-[11px] text-white/30 transition hover:text-rose-300">delete</button>
                  ) : (
                    <span className="font-jetbrains text-[11px] text-white/15">locked</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
