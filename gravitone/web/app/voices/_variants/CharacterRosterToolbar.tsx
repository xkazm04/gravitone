"use client";

import { useRef } from "react";
import Link from "next/link";

/** Search, filter, and the three ways to put a Character into the roster. */
export default function CharacterRosterToolbar({
  query, setQuery, tagFilter, setTagFilter, allTags, importing, cloning,
  onPack, onFile, onClearCollision, shown, total,
}: {
  query: string;
  setQuery: (q: string) => void;
  tagFilter: string | null;
  setTagFilter: (t: string | null) => void;
  allTags: string[];
  importing: boolean;
  cloning: boolean;
  onPack: (f: File, rename?: string) => Promise<void>;
  onFile: (f: File, opts?: { name?: string; attested?: boolean }) => Promise<void>;
  onClearCollision: () => void;
  shown: number;
  total: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const packRef = useRef<HTMLInputElement>(null);

  return (
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
        onChange={(e) => { const f = e.target.files?.[0]; onClearCollision(); if (f) void onFile(f); e.target.value = ""; }} />
      <button onClick={() => fileRef.current?.click()} disabled={cloning}
        className="font-jetbrains rounded-full border border-white/12 px-3 py-2 text-[12px] text-white/70 transition hover:text-white disabled:opacity-50">
        {cloning ? "cloning…" : "quick clone"}
      </button>
      <span className="font-jetbrains ml-auto text-[11px] text-white/60">{shown} of {total}</span>
    </div>
  );
}
