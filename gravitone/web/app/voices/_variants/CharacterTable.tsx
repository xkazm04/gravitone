"use client";

// CHARACTER OVERVIEW — the winning Table direction, now at the Character layer.
// A Character groups Voices across the emotion scale; this table is the roster.
// Drill into a row to work with that Character's individual emotion Voices.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Eyebrow } from "@/components/ui/Primitives";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import TagEditor from "./TagEditor";
import { hueOf, relTime, useCharacters, useVoicePreview, patchCharacterReq, deleteCharacterReq, collisionVoice, bulkDeleteQuestion, deleteCharacterQuestion, weakestVoice, weaknessOf, type Character } from "../_data/characters";
import SignalChip from "./SignalChip";
import { ApiError, readDetail } from "@/lib/apiFetch";
import { useAuth } from "@/lib/useAuth";
import { useMounted } from "@/lib/useMounted";
import { CONSENT_PROMPT, recordVoiceOwnership } from "@/lib/voiceVault";

type SortKey = "name" | "category" | "lang" | "coverage" | "weakest" | "demand" | "created";

/** Unmet demand for a Character: total requests over its STILL-MISSING emotions
 *  (a slot already recorded isn't unmet), plus the hottest missing slot to
 *  record next. The backend already prunes recorded slots from `demand`; we
 *  re-filter defensively so the number can never count a filled emotion. */
function unmetDemand(c: Character): { total: number; hottest: string | null } {
  let total = 0;
  let hottest: string | null = null;
  let max = 0;
  for (const [emotion, n] of Object.entries(c.demand ?? {})) {
    if (c.emotions.includes(emotion)) continue; // recorded → met, not unmet
    total += n;
    if (n > max) { max = n; hottest = emotion; }
  }
  return { total, hottest };
}

/** Run `task` over `items` with at most `limit` in flight; collects failures. */
async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<Error[]> {
  const errors: Error[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await task(item); }
      catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
    }
  });
  await Promise.all(workers);
  return errors;
}

function CoverageBar({ c }: { c: Character }) {
  // Pips track this Character's OWN scale (base + its custom slots), so the pip
  // count always matches the "n/total" number even for extended palettes.
  const scale = c.scale?.length ? c.scale : EMOTION_IDS;
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-[2px]">
        {scale.map((id) => {
          const m = emotionMeta(id);
          const on = c.emotions.includes(id);
          return (
            <span
              key={id}
              title={`${m.label}${on ? "" : " — missing (falls back to baseline)"}`}
              className="h-4 w-1.5 rounded-sm"
              style={{ background: on ? `hsl(${m.hue} 80% 60%)` : "rgba(255,255,255,0.10)" }}
            />
          );
        })}
      </div>
      <span className="font-jetbrains text-[11px] text-white/65">{c.coverage}/{c.total}</span>
      {/* WORST-SLOT HINT — coverage says how many voices exist, this says which
          one is the weak one. It is a link, not a badge: the whole point of the
          ledger is that the next action is one click away, and `?record=` is the
          param the guided recorder already opens on. Renders nothing when no
          Voice is flagged (a clean roster, or one measured before the ledger). */}
      {(() => {
        const weakest = weakestVoice(c);
        if (!weakest) return null;
        const label = emotionMeta(weakest.voice.emotion).label;
        return (
          <Link href={`/voices/${c.character_id}?record=${encodeURIComponent(weakest.voice.emotion)}`}
            aria-label={`Re-record the ${label} voice of ${c.name} — ${weakest.signal.label}`}
            className="transition hover:brightness-125">
            <SignalChip signal={weakest.signal} note={`weakest slot: ${label}`} />
          </Link>
        );
      })()}
      {c.category === "cloned" && c.voices.length > 0 && (() => {
        const withReceipt = c.voices.filter((v) => v.consent).length;
        const all = withReceipt === c.voices.length;
        return (
          <span
            title={`${withReceipt} of ${c.voices.length} voice${c.voices.length > 1 ? "s" : ""} carry a consent receipt`}
            className={`font-jetbrains inline-flex items-center gap-0.5 text-[11px] ${all ? "text-emerald-300/90" : withReceipt > 0 ? "text-emerald-300/60" : "text-white/25"}`}
          >
            🛡 {withReceipt}
          </span>
        );
      })()}
    </div>
  );
}

export default function CharacterTable() {
  const { characters, loading, error, readFailed, deleting, createVoice, patchCharacter, deleteCharacter, refresh } = useCharacters();
  const { preview, playingId, busyId, failedId, failedReason } = useVoicePreview();
  const { user } = useAuth();
  const mounted = useMounted();

  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "category", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [bulkTag, setBulkTag] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);
  // A quick clone that 409'd on a taken id. The FILE is kept: the id is taken,
  // the recording is fine, and discarding it made the user re-pick the file to
  // answer a question we could have asked with it still in hand.
  const [collision, setCollision] = useState<{ file: File; name: string; detail: string } | null>(null);
  const [retryName, setRetryName] = useState("");
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [vaultWarn, setVaultWarn] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const packRef = useRef<HTMLInputElement>(null);
  const cancelRename = useRef(false); // Escape sets this so the unmount's onBlur doesn't commit

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

  const clonedSelected = [...selected].filter((id) => characters.find((c) => c.character_id === id)?.category === "cloned");
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.character_id));

  function toggleSort(key: SortKey) {
    // Demand and weakest open worst-first (desc) — both exist to answer "what
    // should I do next", and that answer is at the top. Everything else ascends.
    setSort((s) => (s.key === key
      ? { key, dir: s.dir === 1 ? -1 : 1 }
      : { key, dir: key === "demand" || key === "weakest" ? -1 : 1 }));
  }
  function toggleOne(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  async function applyBulkTag() {
    const t = bulkTag.trim().toLowerCase();
    if (!t) return;
    const chosen = [...selected]
      .map((id) => characters.find((x) => x.character_id === id))
      .filter((c): c is Character => !!c);
    // PATCH 409s a built-in ("cannot be renamed"), so tagging one was always a
    // guaranteed failure dressed up as a bulk action. Skip them and SAY so.
    const builtIns = chosen.filter((c) => c.category === "premade");
    const targets = chosen.filter((c) => c.category === "cloned" && !c.tags.includes(t));
    setCloneErr(null);
    setBulkNotice(builtIns.length
      ? `${builtIns.length} built-in character${builtIns.length > 1 ? "s were" : " was"} skipped — built-ins cannot be retagged`
      : null);
    // Bounded parallel (≤6 in flight) + one refresh at the end, instead of N
    // serial round-trips each triggering their own re-sync.
    const errs = await runPool(targets, 6, async (c) => { await patchCharacterReq(c.character_id, { tags: [...c.tags, t] }); });
    setBulkTag("");
    await refresh();
    if (errs.length) setCloneErr(`${errs.length} tag update${errs.length > 1 ? "s" : ""} failed: ${errs[0].message}`);
  }
  /** Destroy every selected CLONED character at once.
   *
   *  The one action on this page that can destroy dozens of embeddings from a
   *  single click, so it is the one that most needs to say how many — the
   *  selection bar is the only place the count exists, and a bare "are you
   *  sure?" over a selection made minutes ago is not a question. */
  async function bulkDelete() {
    if (bulkDeleting) return; // in-flight gate
    const targets = clonedSelected
      .map((id) => characters.find((c) => c.character_id === id))
      .filter((c): c is Character => !!c);
    if (targets.length === 0) return;
    if (!window.confirm(bulkDeleteQuestion(targets))) return;
    setBulkDeleting(true);
    setCloneErr(null);
    const errs = await runPool(targets, 6, (c) => deleteCharacterReq(c.character_id));
    if (!mounted.current) return;
    setSelected(new Set());
    await refresh();
    if (!mounted.current) return;
    setBulkDeleting(false);
    // The ones that failed are still in the roster the refresh just re-read —
    // say that, rather than leaving "N deletes failed" to be read as "gone".
    if (errs.length) {
      setCloneErr(
        `${errs.length} of ${targets.length} delete${targets.length > 1 ? "s" : ""} failed: `
        + `${errs[0].message} — those characters are still in your roster.`,
      );
    }
  }
  /** Quick clone: one file → one Character named after it.
   *
   *  The name comes from the FILENAME, and the built-in ids are ordinary first
   *  names (mary, jane, paul…), so dropping `mary.wav` is a guaranteed 409.
   *  That used to be a generic banner with the file thrown away. Now the 409 is
   *  caught on its own: the file is retained and the user picks another name.
   *
   *  `name` re-runs the clone with a different Character name; `attested` says
   *  the consent gate was already answered for this same file. */
  async function onFile(f: File, opts: { name?: string; attested?: boolean } = {}) {
    if (cloning) return; // in-flight gate — a double-click must not clone twice
    if (!opts.attested && !window.confirm(CONSENT_PROMPT)) return; // Voice Vault attestation gate
    const name = (opts.name ?? f.name.replace(/\.[^.]+$/, "")).trim();
    if (!name) return;
    setCloning(true); setCloneErr(null);
    try {
      const v = await createVoice(f, name, "baseline", [], f.name);
      setCollision(null);
      if (user) {
        // Consume the {saved, failed} result — a dropped consent receipt is a
        // compliance-visible loss, not something to discover later.
        const res = await recordVoiceOwnership(user, [{
          voice_id: v.voice_id, character_id: v.character_id,
          character_name: name, emotion: v.emotion,
        }], "uploaded");
        setVaultWarn(res.failed > 0
          ? "voice cloned, but its consent receipt could not be saved to your vault"
          : null);
      }
    } catch (e) {
      // 409 = "that name is taken" (a built-in id, or a slot this Character
      // already fills). Answerable, so ask instead of dead-ending.
      if (e instanceof ApiError && e.status === 409) {
        setCollision({ file: f, name, detail: e.message });
        setRetryName("");
      } else {
        setCloneErr(e instanceof Error ? e.message : "clone failed");
      }
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
      if (r.status === 409) {
        // The backend says WHICH id and why (a built-in collision reads
        // differently from an existing clone). Asserting "a character with this
        // id already exists" was false copy for the built-in case and threw the
        // real answer away — ask with the backend's own words.
        const detail = (await readDetail(r)) ?? "A character with this id already exists.";
        const name = window.prompt(`${detail}\n\nImport under a different character name:`);
        if (name?.trim()) { setImporting(false); return onPack(f, name.trim()); }
        throw new Error(detail);
      }
      if (!r.ok) throw new Error((await readDetail(r)) ?? `import failed (${r.status})`);
      await refresh();
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : "import failed");
    } finally { setImporting(false); }
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

      {collision && (() => {
        // If the 409 named a voice_id, that id is a place in the app — link it
        // instead of printing a string the user has to hunt for.
        const held = collisionVoice(collision.detail, characters);
        return (
          <div className="mt-4 rounded-lg border border-rose-400/25 bg-rose-400/5 px-4 py-3">
            <p role="alert" className="font-jetbrains text-[11px] text-rose-200">
              {collision.detail}
              {held && (
                <Link href={`/voices/${held.character.character_id}`}
                  className="ml-2 underline decoration-rose-300/40 underline-offset-2 transition hover:text-rose-100">
                  open {held.character.name} → {emotionMeta(held.voice.emotion).label}
                </Link>
              )}
            </p>
            <p className="font-jetbrains mt-1.5 text-[11px] text-white/60">
              Nothing was cloned. “{collision.file.name}” is still here — give it another character name.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                autoFocus value={retryName} onChange={(e) => setRetryName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && retryName.trim()) void onFile(collision.file, { name: retryName, attested: true }); }}
                placeholder={`${collision.name} 2`} aria-label="Character name"
                className="font-jetbrains w-48 rounded border border-white/15 bg-transparent px-2 py-1 text-[12px] text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
              <button
                onClick={() => void onFile(collision.file, { name: retryName, attested: true })}
                disabled={!retryName.trim() || cloning}
                className="font-jetbrains rounded border border-cyan-400/30 px-2 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-400/10 disabled:opacity-40">
                {cloning ? "cloning…" : "clone under this name"}
              </button>
              <button onClick={() => setCollision(null)} disabled={cloning}
                className="font-jetbrains text-[11px] text-white/55 transition hover:text-white disabled:opacity-40">
                discard the file
              </button>
            </div>
          </div>
        );
      })()}

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
          onChange={(e) => { const f = e.target.files?.[0]; setCollision(null); if (f) void onFile(f); e.target.value = ""; }} />
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
          <button onClick={bulkDelete} disabled={clonedSelected.length === 0 || bulkDeleting}
            className="font-jetbrains rounded border border-rose-400/30 px-2 py-1 text-[11px] text-rose-300 disabled:opacity-30 hover:bg-rose-400/10">
            {bulkDeleting ? "deleting…" : `delete ${clonedSelected.length} cloned`}
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
            {!loading && !rosterUnavailable && rows.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-white/60">
                {characters.length === 0
                  ? "No characters yet — clone a recording or import a pack to make one."
                  : "No characters match."}
              </td></tr>
            )}
            {rows.map((c) => {
              const baseline = c.voices.find((v) => v.emotion === "baseline") ?? c.voices[0];
              // PATCH /v1/characters 409s a built-in, so rename and tag editing
              // were offered, optimistically painted, refused and snapped back.
              // Don't offer what the backend will refuse.
              const editable = c.category === "cloned";
              return (
                <tr key={c.character_id} className={`border-b border-white/5 transition hover:bg-white/[0.03] ${selected.has(c.character_id) ? "bg-cyan-400/[0.04]" : ""}`}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(c.character_id)} onChange={() => toggleOne(c.character_id)} aria-label={`Select ${c.name}`} className="accent-cyan-400" />
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
                  <td className="px-3 py-2"><CoverageBar c={c} /></td>
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
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
