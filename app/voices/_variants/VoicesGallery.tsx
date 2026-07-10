"use client";

// GALLERY — browse metaphor. Voices are portraits on a wall: a visual card per
// voice, a generous drop-zone to clone a new one. Optimised for recognition and
// exploration, not bulk work. (Table variant covers scale.)

import { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import TagEditor from "./TagEditor";
import { hueOf, relTime, useVoicePreview, useVoices, type Voice } from "./data";

export default function VoicesGallery() {
  const { voices, loading, error, createVoice, patchVoice, removeVoice } = useVoices();
  const { preview, playingId, busyId } = useVoicePreview();

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const allTags = useMemo(
    () => Array.from(new Set(voices.flatMap((v) => v.tags))).sort(),
    [voices]
  );

  const shown = useMemo(
    () =>
      voices.filter((v) => {
        const q = query.trim().toLowerCase();
        const matchQ = !q || v.name.toLowerCase().includes(q) || v.voice_id.includes(q);
        const matchT = !tagFilter || v.tags.includes(tagFilter);
        return matchQ && matchT;
      }),
    [voices, query, tagFilter]
  );

  async function clone() {
    if (!file || !name.trim() || cloning) return;
    setCloning(true);
    setCloneErr(null);
    try {
      await createVoice(file, name.trim(), tagsRaw.split(",").map((t) => t.trim()).filter(Boolean), file.name);
      setFile(null); setName(""); setTagsRaw("");
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : "clone failed");
    } finally {
      setCloning(false);
    }
  }

  return (
    <div className="pb-24">
      <Eyebrow>voice library</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">Your voices.</h1>

      {error && (
        <p className="font-jetbrains mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">
          {error} — start the service or set GRAVITONE_URL.
        </p>
      )}

      {/* clone bay */}
      <div className="glass-panel mt-8 rounded-2xl p-6">
        <div className="font-jetbrains mb-4 text-[11px] uppercase tracking-widest text-white/40">clone a voice</div>
        <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) { setFile(f); if (!name) setName(f.name.replace(/\.[^.]+$/, "")); }
            }}
            onClick={() => inputRef.current?.click()}
            className={`grid cursor-pointer place-items-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
              dragging ? "border-cyan-400/60 bg-cyan-400/5" : "border-white/12 hover:border-white/25"
            }`}
          >
            <input
              ref={inputRef} type="file" accept="audio/*,video/mp4" hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) { setFile(f); if (!name) setName(f.name.replace(/\.[^.]+$/, "")); }
              }}
            />
            <div>
              <div className="text-base text-white">{file ? file.name : "Drop a recording, or click to choose"}</div>
              <div className="font-jetbrains mt-1 text-[11px] text-white/40">
                {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "wav · mp3 · m4a — 10–30s of clean speech clones best"}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <input
              value={name} onChange={(e) => setName(e.target.value)} placeholder="Voice name"
              className="font-hanken rounded-xl border border-white/12 bg-white/[0.03] px-4 py-3 text-base text-white placeholder:text-white/30 focus:border-cyan-400/40 focus:outline-none"
            />
            <input
              value={tagsRaw} onChange={(e) => setTagsRaw(e.target.value)} placeholder="tags, comma, separated"
              className="font-jetbrains rounded-xl border border-white/12 bg-white/[0.03] px-4 py-3 text-sm text-white placeholder:text-white/30 focus:border-cyan-400/40 focus:outline-none"
            />
            {cloneErr && <p className="font-jetbrains text-[11px] text-rose-300">{cloneErr}</p>}
            <div className="flex items-center justify-between">
              <span className="font-jetbrains text-[11px] text-white/40">cloning takes ~20s</span>
              <Button onClick={clone} disabled={!file || !name.trim() || cloning}>
                {cloning ? "Cloning…" : "Clone voice"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* filters */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <input
          value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search voices…"
          className="font-hanken w-64 rounded-full border border-white/12 bg-white/[0.03] px-4 py-2 text-sm text-white placeholder:text-white/30 focus:border-cyan-400/40 focus:outline-none"
        />
        <div className="flex flex-wrap gap-1.5">
          {allTags.map((t) => (
            <button
              key={t}
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
              className={`font-jetbrains rounded-full border px-2.5 py-1 text-[11px] transition ${
                tagFilter === t ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/55 hover:text-white"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="font-jetbrains ml-auto text-[11px] text-white/40">{shown.length} of {voices.length}</span>
      </div>

      {/* grid */}
      {loading ? (
        <div className="mt-8 text-sm text-white/40">Loading voices…</div>
      ) : (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((v, i) => (
            <motion.div
              key={v.voice_id}
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE, delay: Math.min(i, 8) * 0.03 }}
              className="glass-panel rounded-2xl p-5"
            >
              <div className="flex items-start gap-3">
                <span
                  className="h-11 w-11 shrink-0 rounded-full"
                  style={{ background: `radial-gradient(circle at 30% 30%, hsl(${hueOf(v.voice_id)} 90% 70%), hsl(${hueOf(v.voice_id)} 80% 45%))` }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-medium text-white">{v.name}</div>
                  <div className="font-jetbrains mt-0.5 text-[11px] text-white/45">
                    {v.category === "cloned" ? `cloned · ${v.sample_seconds ?? "?"}s sample` : "built-in"} · {v.lang}
                    {v.created && ` · ${relTime(v.created)}`}
                  </div>
                </div>
                <button
                  onClick={() => preview(v)}
                  disabled={busyId === v.voice_id}
                  aria-label="Preview voice"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-cyan-300 text-slate-950 transition hover:brightness-110 disabled:opacity-50"
                >
                  {busyId === v.voice_id ? "…" : playingId === v.voice_id ? "⏸" : "▶"}
                </button>
              </div>

              <div className="mt-4">
                <TagEditor tags={v.tags} onChange={(tags) => patchVoice(v.voice_id, { tags })} />
              </div>

              {v.category === "cloned" && (
                <button
                  onClick={() => removeVoice(v.voice_id)}
                  className="font-jetbrains mt-4 text-[11px] text-white/35 transition hover:text-rose-300"
                >
                  delete voice
                </button>
              )}
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
