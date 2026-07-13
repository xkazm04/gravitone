"use client";

// CONSOLE (round 2) — operator/terminal metaphor, now Character-aware.
//   * Pick a Character (a speaker); metatags switch its emotion Voices inline.
//   * Expression panel exposes the model's REAL knobs (temperature / stability /
//     quality). Pocket TTS has no emotion or speed parameter — expression lives
//     in the reference audio, which is why emotions are Voices, not sliders.
//   * Missing emotions fall back to baseline; the take shows what actually ran.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import { EMOTION_IDS, emotionMeta, wrapWithTag } from "@/lib/emotions";
import EmotionArt from "@/components/ui/EmotionArt";
import { DEFAULT_EXPRESSION, DEFAULT_TEXT, stripTags, type Expression, type PerfLine, type Take } from "./shared";
import { speak, perform, uploadTake, EngineBusyError } from "./engine";
import { putTake, getRecentTakes, deleteTake } from "@/lib/takeStore";
import { useAudioPlayer } from "./useAudioPlayer";
import EmotionPicker from "./EmotionPicker";
import TakeCode from "./TakeCode";

type Character = {
  character_id: string; name: string; category: "cloned" | "premade";
  emotions: string[]; coverage: number; total: number; lang: string;
  scale?: string[]; custom_emotions?: string[]; // the character's own palette
};

function Bars({ peaks, progress = 0, active = false, className = "" }: { peaks: number[]; progress?: number; active?: boolean; className?: string }) {
  return (
    <div className={`flex items-end gap-[2px] ${className}`} aria-hidden>
      {peaks.map((h, i) => {
        const played = active && i / peaks.length <= progress;
        return <span key={i} className={`w-[2px] shrink-0 rounded-full transition-colors duration-75 ${played ? "bg-cyan-300" : "bg-white/25"}`} style={{ height: `${Math.max(6, Math.round(h * 100))}%` }} />;
      })}
    </div>
  );
}

function Slider({ label, hint, value, min, max, step, onChange, format }: {
  label: string; hint: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format: (v: number) => string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/65">{label}</span>
        <span className="font-jetbrains text-[12px] text-cyan-300">{format(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-cyan-300" />
      <p className="font-jetbrains mt-1 text-[11px] text-white/55">{hint}</p>
    </div>
  );
}

// One directed line in the Script composer (stable id for keys + reordering).
type ScriptLine = { id: string; characterId: string; text: string };

export default function PlaygroundConsole() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [charId, setCharId] = useState<string>("");
  const [expr, setExpr] = useState<Expression>(DEFAULT_EXPRESSION);
  // Composer mode: Solo = one Character throughout (current flow); Script = a
  // multi-character performance rendered as one take via /v1/performance.
  const [mode, setMode] = useState<"solo" | "script">("solo");
  const [script, setScript] = useState<ScriptLine[]>([]);
  const [activeLine, setActiveLine] = useState(0); // emotion tags target this line
  const lineRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const scriptSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  // Backpressure (429): engine is up but busy — offer a retry, never fall to
  // the browser voice. null = no pending backpressure.
  const [busyNotice, setBusyNotice] = useState<{ retryAfterSec: number } | null>(null);
  // Transient error surface so generation failures are never silent.
  const [toast, setToast] = useState<string | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [codeFor, setCodeFor] = useState<string | null>(null); // take id with the code panel open
  // take id → shared state: publishing / share id / failed
  const [shares, setShares] = useState<Record<string, string | "pending" | "error">>({});
  // client-review link: selected take ids → /r/{id}
  const [reviewSel, setReviewSel] = useState<Set<string>>(new Set());
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const seq = useRef(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const { playingId, paused, progress, toggle, stop } = useAudioPlayer();

  const [preferred, setPreferred] = useState<{ character_id: string | null; picks: number }>({ character_id: null, picks: 0 });

  useEffect(() => {
    // Default to the character clients have actually approved most often —
    // the review loop's pick data feeding back into the studio.
    Promise.all([
      fetch("/api/characters", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])),
      fetch("/api/reviews/preferred", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { character_id: null, picks: 0 })),
    ])
      .then(([cs, pref]: [Character[], { character_id: string | null; picks: number }]) => {
        setCharacters(cs);
        setPreferred(pref);
        const winner = pref.character_id && cs.find((c) => c.character_id === pref.character_id);
        setCharId((winner || cs[0])?.character_id ?? "");
      })
      .catch(() => setCharacters([]));
  }, []);

  // Restore the most recent session takes from IndexedDB on mount so a refresh
  // no longer destroys the log. Each restored take carries a fresh object URL.
  useEffect(() => {
    let cancelled = false;
    getRecentTakes(20)
      .then((restored) => {
        if (cancelled || restored.length === 0) {
          // Unmounted before restore landed — revoke the URLs we just minted.
          if (cancelled) for (const t of restored) if (t.url) URL.revokeObjectURL(t.url);
          return;
        }
        setTakes((current) => {
          const known = new Set(current.map((t) => t.id));
          return [...current, ...restored.filter((t) => !known.has(t.id))];
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Revoke every take's object URL on unmount so navigating away doesn't leak
  // them (object URLs outlive component teardown in an SPA).
  const takesRef = useRef<Take[]>([]);
  useEffect(() => { takesRef.current = takes; }, [takes]);
  useEffect(() => () => {
    for (const t of takesRef.current) if (t.url) URL.revokeObjectURL(t.url);
  }, []);

  // In Script mode the emotion palette follows the line being edited (each line
  // may name a different Character); in Solo mode it follows the character rail.
  const activeCharId = mode === "script" ? (script[activeLine]?.characterId ?? charId) : charId;
  const character = useMemo(
    () => characters.find((c) => c.character_id === activeCharId),
    [characters, activeCharId],
  );
  const charName = (id: string) => characters.find((c) => c.character_id === id)?.name ?? id;
  // The active Character's palette: base scale + its custom slots.
  const scale = useMemo(
    () => (character?.scale?.length ? character.scale : EMOTION_IDS),
    [character],
  );
  const plain = stripTags(text);
  const estSec = Math.max(1.5, Math.round(plain.length * 0.055 * 10) / 10);
  // Script mode: the non-empty lines that will actually be synthesized.
  const scriptLines = useMemo(
    () => script.filter((l) => stripTags(l.text).trim() && l.characterId),
    [script],
  );
  const scriptChars = scriptLines.reduce((n, l) => n + stripTags(l.text).length, 0);
  const canGenerate = mode === "script" ? scriptLines.length > 0 : (!!plain && !!character);
  const usingFallback = takes.some((t) => t.mode === "browser");

  function insertEmotion(emotion: string) {
    if (mode === "script") {
      const idx = activeLine;
      const cur = script[idx];
      if (!cur) return;
      const el = lineRefs.current[idx];
      const start = el?.selectionStart ?? cur.text.length;
      const end = el?.selectionEnd ?? cur.text.length;
      const { next, caret } = wrapWithTag(cur.text, start, end, emotion);
      updateLine(idx, { text: next });
      requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(caret, caret); });
      return;
    }
    const el = areaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const { next, caret } = wrapWithTag(text, start, end, emotion);
    setText(next);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(caret, caret); });
  }

  // --- Script composer helpers ---------------------------------------------
  function newLine(characterId: string, lineText = ""): ScriptLine {
    scriptSeq.current += 1;
    return { id: `line-${scriptSeq.current}`, characterId, text: lineText };
  }
  function updateLine(idx: number, patch: Partial<ScriptLine>) {
    setScript((s) => s.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLine() {
    const cid = script[script.length - 1]?.characterId || charId || characters[0]?.character_id || "";
    setScript((s) => [...s, newLine(cid)]);
  }
  function removeLine(idx: number) {
    setScript((s) => (s.length <= 1 ? s : s.filter((_, i) => i !== idx)));
    setActiveLine((a) => Math.max(0, Math.min(a, script.length - 2)));
  }
  function moveLine(idx: number, dir: -1 | 1) {
    setScript((s) => {
      const j = idx + dir;
      if (j < 0 || j >= s.length) return s;
      const n = [...s];
      [n[idx], n[j]] = [n[j], n[idx]];
      return n;
    });
  }
  /** Switch composer mode, seeding a starter two-character script on first use. */
  function switchMode(m: "solo" | "script") {
    if (m === "script" && script.length === 0) {
      const first = charId || characters[0]?.character_id || "";
      const second = characters.find((c) => c.character_id !== first)?.character_id || first;
      setScript([
        newLine(first, "Hello there."),
        newLine(second, "[excited]Great to finally meet you![/excited]"),
      ]);
      setActiveLine(0);
    }
    setMode(m);
  }

  /** Persist a take server-side, mint its /t/{id} page, copy the link. */
  async function share(t: Take) {
    const existing = shares[t.id];
    if (existing && existing !== "pending" && existing !== "error") {
      // Already published — clicking again just re-copies the link.
      await navigator.clipboard.writeText(`${window.location.origin}/t/${existing}`).catch(() => {});
      return;
    }
    if (!t.url || existing === "pending") return;
    setShares((s) => ({ ...s, [t.id]: "pending" }));
    try {
      const id = await uploadTake(t);
      setShares((s) => ({ ...s, [t.id]: id }));
      await navigator.clipboard.writeText(`${window.location.origin}/t/${id}`).catch(() => {});
    } catch {
      setShares((s) => ({ ...s, [t.id]: "error" }));
      setTimeout(() => setShares((s) => { const { [t.id]: _, ...rest } = s; return rest; }), 2000);
    }
  }

  /** Publish a take if needed and return its share id (the review needs one). */
  async function ensureShared(t: Take): Promise<string> {
    const existing = shares[t.id];
    if (existing && existing !== "pending" && existing !== "error") return existing;
    const id = await uploadTake(t);
    setShares((s) => ({ ...s, [t.id]: id }));
    return id;
  }

  /** Bundle the selected takes into a no-login client approval link. */
  async function createReview() {
    if (reviewSel.size < 2 || reviewBusy) return;
    setReviewBusy(true); setReviewErr(null); setReviewUrl(null);
    try {
      const chosen = takes.filter((t) => reviewSel.has(t.id));
      const ids = await Promise.all(chosen.map(ensureShared));
      const r = await fetch("/api/reviews", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${chosen[0].characterName} — pick a take`, take_ids: ids }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.detail ?? "could not create the review");
      const url = `${window.location.origin}/r/${j.review_id}`;
      setReviewUrl(url);
      setReviewSel(new Set());
      await navigator.clipboard.writeText(url).catch(() => {});
    } catch (e) {
      setReviewErr(e instanceof Error ? e.message : "could not create the review");
    } finally { setReviewBusy(false); }
  }

  /** Persist a take (audio blob + metadata) so it survives a refresh. */
  async function persistTake(t: Take) {
    try {
      const blob = t.url ? await (await fetch(t.url)).blob() : null;
      await putTake(t, blob);
    } catch { /* best-effort — the take still lives in state */ }
  }

  /** Delete a take: revoke its object URL, drop it from the store + all state. */
  function removeTake(id: string) {
    setTakes((list) => {
      const t = list.find((x) => x.id === id);
      if (t?.url) URL.revokeObjectURL(t.url);
      return list.filter((x) => x.id !== id);
    });
    setReviewSel((s) => { const n = new Set(s); n.delete(id); return n; });
    setCodeFor((c) => (c === id ? null : c));
    setShares((s) => { const { [id]: _, ...rest } = s; return rest; });
    void deleteTake(id);
  }

  /** Dispatch to the active composer mode; wired to ⌘↵ and the retry button. */
  function generate() {
    if (mode === "script") void generateScript();
    else void generateSolo();
  }

  async function generateScript() {
    if (busy || scriptLines.length === 0) return;
    setBusy(true);
    setBusyNotice(null);
    setToast(null);
    const lines: PerfLine[] = scriptLines.map((l) => ({ character_id: l.characterId, text: l.text.trim() }));
    try {
      const r = await perform(lines, expr);
      seq.current += 1;
      const distinct = [...new Set(lines.map((l) => l.character_id))];
      const label = distinct.length === 1 ? charName(distinct[0]) : `Ensemble · ${distinct.length} voices`;
      const transcript = lines.map((l) => `${charName(l.character_id)}: ${stripTags(l.text)}`).join("  ·  ");
      const take: Take = {
        id: `take-${Date.now()}-${seq.current}`, text: transcript,
        characterId: lines[0].character_id, characterName: label,
        mode: r.mode, url: r.url, peaks: r.peaks, seconds: r.seconds, kb: r.kb, rtf: r.rtf,
        synthSeconds: r.synthSeconds, queueSeconds: r.queueSeconds,
        ignoredSettings: r.ignoredSettings, segments: r.segments, expr: { ...expr },
        createdAt: Date.now(), lines,
      };
      setTakes((t) => [take, ...t]);
      void persistTake(take);
    } catch (e) {
      if (e instanceof EngineBusyError) setBusyNotice({ retryAfterSec: e.retryAfterSec });
      else setToast("Generation failed — the backend returned an error. Please try again.");
    } finally { setBusy(false); }
  }

  async function generateSolo() {
    if (!plain || busy || !character) return;
    setBusy(true);
    setBusyNotice(null);
    setToast(null);
    try {
      const r = await speak(text, character.character_id, expr);
      seq.current += 1;
      // Timestamped id so restored takes (which keep their stored ids) never
      // collide with freshly generated ones.
      const take: Take = {
        id: `take-${Date.now()}-${seq.current}`, text: text.trim(),
        characterId: character.character_id, characterName: character.name,
        mode: r.mode, url: r.url, peaks: r.peaks, seconds: r.seconds, kb: r.kb, rtf: r.rtf,
        synthSeconds: r.synthSeconds, queueSeconds: r.queueSeconds,
        ignoredSettings: r.ignoredSettings, segments: r.segments, expr: { ...expr },
        createdAt: Date.now(),
      };
      setTakes((t) => [take, ...t]);
      void persistTake(take);
    } catch (e) {
      // Backpressure keeps the engine reachable — offer a retry. Anything else
      // is a genuine failure that must be visible, not swallowed.
      if (e instanceof EngineBusyError) {
        setBusyNotice({ retryAfterSec: e.retryAfterSec });
      } else {
        setToast("Generation failed — the backend returned an error. Please try again.");
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="pb-24">
      <EmotionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={insertEmotion}
        available={character?.emotions ?? ["baseline"]}
        scale={scale}
        characterName={character?.name ?? "Character"}
        characterId={character?.character_id ?? ""}
      />
      <Eyebrow>free playground</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">Compose a take.</h1>
      <p className="mt-2 max-w-2xl text-base text-white/70">
        Pick a <span className="text-white">Character</span>, then use{" "}
        <span className="font-jetbrains text-cyan-300">[emotion]…[/emotion]</span> to switch its{" "}
        <span className="text-white">Voices</span> mid-sentence. Missing emotions fall back to baseline.
      </p>

      {usingFallback && (
        <p className="font-jetbrains mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">
          Gravitone backend unreachable — speaking with your browser voice (metatags ignored).
        </p>
      )}

      {busyNotice && (
        <div className="font-jetbrains mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">
          <span>Engine busy — the render queue is full. Retry in a moment{busyNotice.retryAfterSec > 0 ? ` (~${busyNotice.retryAfterSec}s)` : ""}.</span>
          <button
            onClick={() => void generate()}
            disabled={busy}
            className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-amber-100 transition hover:bg-amber-400/20 disabled:opacity-40"
          >
            {busy ? "retrying…" : "↻ retry"}
          </button>
        </div>
      )}

      {toast && (
        <div className="font-jetbrains mt-4 flex items-center justify-between gap-3 rounded-lg border border-rose-400/30 bg-rose-400/5 px-4 py-2 text-[11px] text-rose-200/90">
          <span>{toast}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="text-rose-200/70 transition hover:text-rose-100">✕</button>
        </div>
      )}

      {/* character rail */}
      <div className="mt-8">
        <div className="font-jetbrains mb-2 flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-widest text-white/60">
          <span>character</span>
          {preferred.character_id && preferred.picks > 0 && (
            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/5 px-2 py-0.5 normal-case tracking-normal text-emerald-200/90">
              ✓ client-approved default · {preferred.picks} pick{preferred.picks > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {characters.slice(0, 10).map((c) => {
            const on = c.character_id === charId;
            return (
              <button key={c.character_id} onClick={() => setCharId(c.character_id)} aria-pressed={on}
                className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition ${on ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/10 hover:border-white/25"}`}>
                <span className="h-6 w-6 rounded-full" style={{ background: `radial-gradient(circle at 30% 30%, hsl(${(c.character_id.length * 47) % 360} 90% 70%), hsl(${(c.character_id.length * 47) % 360} 80% 45%))` }} />
                <span>
                  <span className="block text-sm text-white">{c.name}</span>
                  <span className="font-jetbrains text-[11px] text-white/60">{c.category} · {c.coverage}/{c.total} emotions</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
        {/* compose bay */}
        <div className="glass-panel rounded-2xl">
          <div className="font-jetbrains flex items-center justify-between border-b border-white/8 px-5 py-2.5 text-[11px] uppercase tracking-widest text-white/60">
            <div className="flex items-center gap-1">
              {(["solo", "script"] as const).map((m) => (
                <button key={m} onClick={() => switchMode(m)} aria-pressed={mode === m}
                  title={m === "solo" ? "One Character throughout" : "A multi-character performance in one take"}
                  className={`rounded-full border px-2.5 py-0.5 transition ${mode === m ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200" : "border-transparent text-white/50 hover:text-white/80"}`}>
                  {m}
                </button>
              ))}
            </div>
            <span>
              {mode === "script"
                ? `${scriptChars} chars · ${scriptLines.length} line${scriptLines.length === 1 ? "" : "s"}`
                : `${plain.length} chars · ~${estSec}s audio`}
            </span>
          </div>

          {mode === "solo" ? (
            <textarea ref={areaRef} value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate(); }}
              rows={5} placeholder="Type something. Select words, then click an emotion to tag them…"
              className="font-hanken w-full resize-none bg-transparent px-5 py-4 text-base leading-relaxed text-white placeholder:text-white/55 focus:outline-none" />
          ) : (
            <div className="space-y-2 px-5 py-4">
              {script.map((line, i) => (
                <div key={line.id}
                  className={`rounded-xl border p-3 transition ${activeLine === i ? "border-cyan-400/25 bg-cyan-400/[0.03]" : "border-white/10 bg-white/[0.02]"}`}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-jetbrains w-4 shrink-0 text-[11px] text-white/40">{i + 1}</span>
                    <span className="h-5 w-5 shrink-0 rounded-full" style={{ background: `radial-gradient(circle at 30% 30%, hsl(${(line.characterId.length * 47) % 360} 90% 70%), hsl(${(line.characterId.length * 47) % 360} 80% 45%))` }} />
                    <select value={line.characterId} onFocus={() => setActiveLine(i)}
                      onChange={(e) => updateLine(i, { characterId: e.target.value })}
                      aria-label={`Character for line ${i + 1}`}
                      className="font-jetbrains min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 transition focus:border-cyan-400/40 focus:outline-none">
                      {characters.map((c) => (
                        <option key={c.character_id} value={c.character_id} className="bg-slate-900 text-white">{c.name}</option>
                      ))}
                    </select>
                    <div className="flex shrink-0 items-center gap-1">
                      <button onClick={() => moveLine(i, -1)} disabled={i === 0} aria-label="Move line up"
                        className="grid h-6 w-6 place-items-center rounded-md border border-white/12 text-[11px] text-white/60 transition enabled:hover:bg-white/5 disabled:opacity-25">↑</button>
                      <button onClick={() => moveLine(i, 1)} disabled={i === script.length - 1} aria-label="Move line down"
                        className="grid h-6 w-6 place-items-center rounded-md border border-white/12 text-[11px] text-white/60 transition enabled:hover:bg-white/5 disabled:opacity-25">↓</button>
                      <button onClick={() => removeLine(i)} disabled={script.length <= 1} aria-label="Remove line"
                        className="grid h-6 w-6 place-items-center rounded-md border border-white/12 text-[11px] text-white/60 transition enabled:hover:border-rose-400/40 enabled:hover:text-rose-200 disabled:opacity-25">✕</button>
                    </div>
                  </div>
                  <textarea
                    ref={(el) => { lineRefs.current[i] = el; }}
                    value={line.text}
                    onFocus={() => setActiveLine(i)}
                    onChange={(e) => updateLine(i, { text: e.target.value })}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate(); }}
                    rows={2}
                    placeholder="Line text… tag with [emotion]…[/emotion] to switch this Character's Voices"
                    className="font-hanken w-full resize-none bg-transparent text-sm leading-relaxed text-white placeholder:text-white/40 focus:outline-none" />
                </div>
              ))}
              <button onClick={addLine}
                className="font-jetbrains w-full rounded-xl border border-dashed border-white/15 py-2 text-[11px] text-white/60 transition hover:border-cyan-400/40 hover:text-cyan-200">
                + add line
              </button>
            </div>
          )}

          {/* emotion chips + wheel */}
          <div className="border-t border-white/8 px-5 py-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">tag selection with an emotion</span>
              <button
                onClick={() => setPickerOpen(true)}
                className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-400/5 px-3 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-400/10"
              >
                ◎ emotion wheel
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {scale.map((id) => {
                const e = emotionMeta(id);
                const has = character?.emotions.includes(id) ?? false;
                const custom = !EMOTION_IDS.includes(id);
                return (
                  <button key={id} onClick={() => insertEmotion(id)}
                    title={has ? `${e.label} — available` : `${e.label} — not recorded, falls back to baseline`}
                    className={`font-jetbrains inline-flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[11px] transition ${
                      has ? `border bg-white/5 text-white/85 ${custom ? "border-violet-400/30 hover:border-violet-400/60" : "border-white/15 hover:border-cyan-400/40"}`
                          : `border border-dashed text-white/60 ${custom ? "border-violet-400/20" : "border-white/12"}`}`}>
                    <span className="grid h-5 w-5 place-items-center overflow-hidden rounded-full bg-black/50">
                      <EmotionArt emotion={id} size={20} dim={!has} />
                    </span>
                    {e.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-white/8 px-5 py-3">
            <span className="font-jetbrains text-[11px] text-white/60">
              {mode === "script" ? "⌘↵ · one take from the whole script · 24kHz wav" : "⌘↵ to generate · exports 24kHz wav"}
            </span>
            <Button onClick={generate} disabled={busy || !canGenerate}>{busy ? "Rendering…" : "Generate ▶"}</Button>
          </div>
        </div>

        {/* expression */}
        <div className="glass-panel rounded-2xl p-5">
          <div className="font-jetbrains mb-4 flex items-center justify-between text-[11px] uppercase tracking-widest text-white/60">
            <span>expression</span>
            <button onClick={() => setExpr(DEFAULT_EXPRESSION)} className="text-white/60 transition hover:text-white">reset</button>
          </div>
          <div className="space-y-5">
            <Slider label="temperature" hint="consistent ⟷ expressive" value={expr.temperature} min={0.5} max={1.0} step={0.05}
              onChange={(v) => setExpr({ ...expr, temperature: v })} format={(v) => v.toFixed(2)} />
            <Slider label="stability" hint="0 = off · tames a high temperature" value={expr.stability} min={0} max={1} step={0.05}
              onChange={(v) => setExpr({ ...expr, stability: v })} format={(v) => (v < 0.01 ? "off" : v.toFixed(2))} />
            <Slider label="quality" hint="decode steps — higher is slower" value={expr.quality} min={1} max={5} step={1}
              onChange={(v) => setExpr({ ...expr, quality: v })} format={(v) => `${v} step${v > 1 ? "s" : ""}`} />
          </div>
          <p className="font-jetbrains mt-5 border-t border-white/8 pt-3 text-[11px] leading-relaxed text-white/55">
            Pocket TTS exposes no emotion or speed parameter — expression comes from the reference
            audio. That is why emotions are separate Voices, and these are the model&apos;s real knobs.
          </p>
        </div>
      </div>

      {/* takes log */}
      <div className="mt-8">
        <div className="font-jetbrains mb-3 flex flex-wrap items-center justify-between gap-3 text-[11px] uppercase tracking-widest text-white/60">
          <span>takes</span>
          <div className="flex flex-wrap items-center gap-3">
            {reviewSel.size > 0 && (
              <>
                <span className="text-cyan-300">{reviewSel.size} selected</span>
                <button
                  onClick={() => void createReview()}
                  disabled={reviewSel.size < 2 || reviewBusy}
                  title={reviewSel.size < 2 ? "Select at least 2 takes to compare" : "Create a no-login link where a client picks the winner"}
                  className="cursor-pointer rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-[11px] normal-case tracking-normal text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
                >
                  {reviewBusy ? "creating…" : "→ client review link"}
                </button>
              </>
            )}
            <span>{takes.length}</span>
          </div>
        </div>

        {reviewUrl && (
          <p className="font-jetbrains mb-3 rounded-lg border border-emerald-400/25 bg-emerald-400/5 px-4 py-2 text-[11px] text-emerald-200/90">
            ✓ review link copied —{" "}
            <a href={reviewUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{reviewUrl}</a>{" "}
            (no login; the client picks one take)
          </p>
        )}
        {reviewErr && (
          <p className="font-jetbrains mb-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">{reviewErr}</p>
        )}

        {takes.length === 0 && !busy && (
          <div className="rounded-2xl border border-dashed border-white/10 px-5 py-10 text-center text-sm text-white/60">
            No takes yet — compose above and hit Generate.
          </div>
        )}

        <AnimatePresence initial={false}>
          {busy && (
            <motion.div key="rendering" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="glass-panel mb-2 flex items-center gap-4 rounded-xl px-5 py-4">
              <span className="font-jetbrains shrink-0 text-[11px] text-cyan-300">rendering</span>
              <div className="flex h-8 flex-1 items-end gap-[2px]">
                {Array.from({ length: 48 }).map((_, i) => (
                  <span key={i} className="eq-bar w-[2px] rounded-full bg-cyan-300/60" style={{ height: "100%", animationDelay: `${(i % 7) * 0.08}s` }} />
                ))}
              </div>
            </motion.div>
          )}

          {takes.map((t) => {
            const isCurrent = playingId === t.id;
            return (
              <motion.div key={t.id} layout initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: EASE }} className="glass-panel mb-2 rounded-xl px-5 py-4">
                <div className="flex items-center gap-3">
                  {/* compare selector — 2+ takes become a client review link */}
                  <input
                    type="checkbox"
                    checked={reviewSel.has(t.id)}
                    disabled={t.mode === "browser"}
                    onChange={(e) =>
                      setReviewSel((s) => {
                        const n = new Set(s);
                        if (e.target.checked) { if (n.size < 6) n.add(t.id); } else n.delete(t.id);
                        return n;
                      })
                    }
                    title={t.mode === "browser" ? "Browser-fallback take — cannot be reviewed" : "Select for a client review link (max 6)"}
                    aria-label="Select take for client review"
                    className="h-4 w-4 shrink-0 accent-cyan-300 disabled:opacity-30"
                  />
                  <button onClick={() => toggle(t)} aria-label={isCurrent && !paused ? "Pause" : "Play"}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-cyan-300 text-slate-950 transition hover:brightness-110">
                    {isCurrent && !paused ? "⏸" : "▶"}
                  </button>
                  <button onClick={stop} disabled={!isCurrent} aria-label="Stop"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/15 text-white/70 transition enabled:hover:bg-white/5 disabled:opacity-25">■</button>

                  <Bars peaks={t.peaks} progress={isCurrent ? progress : 0} active={isCurrent} className="h-9 min-w-0 flex-1" />

                  <div className="font-jetbrains hidden shrink-0 items-center gap-4 text-[11px] text-white/65 sm:flex">
                    <span className="text-white/80">{t.characterName}</span>
                    <span>{t.seconds}s</span>
                    {t.synthSeconds > 0 && <span title="server-side synthesis time">{t.synthSeconds}s synth</span>}
                    {t.queueSeconds > 0 && <span title="time spent waiting in the render queue">{t.queueSeconds}s queue</span>}
                    {t.rtf > 0 && <span className="text-cyan-300">{t.rtf}× rt</span>}
                    {t.kb > 0 && <span>{t.kb} kb</span>}
                  </div>

                  <button
                    onClick={() => void share(t)}
                    disabled={t.mode === "browser" || shares[t.id] === "pending"}
                    title={t.mode === "browser" ? "Browser-speech fallback — nothing to share" : "Publish this take at a public /t/… link (copies the URL)"}
                    className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/80 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-white/50"
                  >
                    {shares[t.id] === "pending" ? "sharing…"
                      : shares[t.id] === "error" ? "✗ failed"
                      : shares[t.id] ? "✓ link copied"
                      : "↗ share"}
                  </button>
                  <button
                    onClick={() => setCodeFor((c) => (c === t.id ? null : t.id))}
                    disabled={t.mode === "browser"}
                    title={t.mode === "browser" ? "Browser-speech fallback take — no API request to export" : "Get this exact take as an API call"}
                    aria-expanded={codeFor === t.id}
                    className={`font-jetbrains shrink-0 rounded-lg border px-3 py-1.5 text-[11px] transition ${
                      codeFor === t.id
                        ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                        : "border-white/15 text-white/80 hover:bg-white/5 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-white/50"
                    }`}
                  >
                    {"</>"} code
                  </button>
                  {t.url ? (
                    <a href={t.url} download={`gravitone-${t.characterId}-${t.id}.wav`}
                      className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/80 transition hover:bg-white/5">↓ wav</a>
                  ) : (
                    <span title="Connect a Gravitone endpoint to export WAV"
                      className="font-jetbrains shrink-0 cursor-not-allowed rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-white/50">↓ wav</span>
                  )}
                  <button
                    onClick={() => removeTake(t.id)}
                    title="Delete this take from the log"
                    aria-label="Delete take"
                    className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/60 transition hover:border-rose-400/40 hover:text-rose-200"
                  >
                    ✕
                  </button>
                </div>

                {codeFor === t.id && t.mode === "gravitone" && <TakeCode take={t} />}

                {/* segment ribbon — what actually ran */}
                {t.segments.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {t.segments.map((s, i) => {
                      const m = emotionMeta(s.used);
                      // Performance segments carry who spoke; solo takes don't.
                      const segCharId = s.characterId ?? t.characterId;
                      const segCharName = s.characterId ? charName(s.characterId) : null;
                      return (
                        <span key={i} title={s.text}
                          className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/70">
                          {segCharName && <span className="text-white/80">{segCharName}</span>}
                          {segCharName && <span className="text-white/30">·</span>}
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${m.hue} 80% 62%)` }} />
                          {s.fallback ? (
                            <><span className="text-amber-300/80 line-through">{s.requested}</span><span className="text-white/55">→</span><span>{s.used}</span></>
                          ) : (
                            <span>{s.used}</span>
                          )}
                          <span className="text-white/55">{s.seconds}s</span>
                          {/* fallback chips upsell the guided recorder */}
                          {s.fallback && EMOTION_IDS.includes(s.requested) && (
                            <Link
                              href={`/voices/${encodeURIComponent(segCharId)}?record=${s.requested}`}
                              title={`${segCharName ?? t.characterName} has no ${s.requested} voice — record it and re-render this take`}
                              className="text-amber-300/90 underline-offset-2 transition hover:text-amber-200 hover:underline"
                            >
                              record →
                            </Link>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}

                {t.ignoredSettings.length > 0 && (
                  <p className="font-jetbrains mt-3 inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-1 text-[11px] text-amber-200/85">
                    <span aria-hidden>⚠</span>
                    {t.ignoredSettings.join(", ")} ignored — not a Pocket TTS knob.
                  </p>
                )}

                <p className="mt-2 line-clamp-1 text-sm text-white/65">{t.text}</p>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
