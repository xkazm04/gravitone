"use client";

// CONSOLE (round 2) — operator/terminal metaphor, now Character-aware.
//   * Pick a Character (a speaker); metatags switch its emotion Voices inline.
//   * Expression panel exposes the model's REAL knobs (temperature / stability /
//     quality). Pocket TTS has no emotion or speed parameter — expression lives
//     in the reference audio, which is why emotions are Voices, not sliders.
//   * A missing emotion is substituted with the nearest recorded one, then
//     baseline; the take's segment ribbon shows what actually ran.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { apiJson } from "@/lib/apiFetch";
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import { useHealthPoll } from "@/lib/useHealthPoll";
import { useMounted } from "@/lib/useMounted";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import { EMOTION_IDS, emotionMeta, wrapWithTag } from "@/lib/emotions";
import EmotionArt from "@/components/ui/EmotionArt";
import {
  appendEdit, composerLimit, DEFAULT_EXPRESSION, DEFAULT_TEXT, isTimingBasis, MAX_SCRIPT_LINES,
  MAX_TEXT_CHARS, readEdits, stripTags, TAKE_TIMING_VERSION,
  type Expression, type PerfLine, type ScriptLine, type Take,
} from "./shared";
// Composer durability — the same IndexedDB mechanism the take log uses.
import { loadComposer, reconcileCharacters, saveComposer, type ComposerState } from "@/lib/composerStore";
import { DEFAULT_OUTPUT_FORMAT, OUTPUT_FORMATS, formatMeta, type OutputFormat } from "@/lib/audioFormats";
import { speak, perform, uploadTake, refinePeaks, EngineBusyError, isAbort, type FallbackReason } from "./engine";
// ONE character-list data layer, shared with the voices module — the playground
// used to fetch /api/characters itself, so the app had two truths about the
// roster (and two places to fix when it went stale).
import { loadRoster, type Character } from "@/app/voices/_data/characters";
import { putTake, getRecentTakes, deleteTake } from "@/lib/takeStore";
import { useAudioPlayer } from "./useAudioPlayer";
import EmotionPicker from "./EmotionPicker";
import TakeCode from "./TakeCode";
import LiveStage from "../_live/LiveStage";
import ScoreEditor from "./ScoreEditor";
import ScriptScore from "./ScriptScore";
// Punch-in: the take log's editing drill-down. Deliberately a separate module —
// the take card stays exactly what it was until the user asks for the timeline.
import PunchIn, { type CommitPayload } from "./PunchIn";
import { dropVariants } from "./variantStore";

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

// How many Characters the rail shows before it has to be expanded. The density
// is deliberate — the overflow is a panel, not a wall of buttons.
const RAIL_PREVIEW = 10;

// What to tell the user when a take came from the browser voice. Each string
// names the ACTUAL cause; "unreachable" is no longer the catch-all.
const FALLBACK_COPY: Record<"unreachable" | "draining" | "failed", string> = {
  unreachable:
    "Gravitone backend unreachable — speaking with your browser voice (metatags ignored).",
  draining:
    "Gravitone is restarting — spoke with your browser voice (metatags ignored). Try again in a moment.",
  failed:
    "Gravitone is reachable but synthesis failed — spoke with your browser voice (metatags ignored).",
};

/** Human duration for the render clock: sub-minute renders read in tenths,
 *  longer ones (a CPU-only script render) in m:ss. */
function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/**
 * The "rendering" row, INCLUDING its ticking clock.
 *
 * The clock used to live in PlaygroundConsole, so every 250ms tick re-rendered
 * the whole take log — and each take card is an AnimatePresence `layout` child
 * that re-measures on every render. The clock only ever drew this one row, so
 * this is where its state belongs. Nothing about what is displayed changed.
 */
function RenderStatus({ startedAt, etaSec, estAudioSec, etaBasisLabel, noEtaLabel, queued, inFlight, metricsUnavailable, healthStale }: {
  startedAt: number | null; etaSec: number | null; estAudioSec: number;
  etaBasisLabel: string; noEtaLabel: string;
  // null = the engine did not report this number. NOT the same as 0, which is
  // a real reading of an empty queue.
  queued: number | null; inFlight: number | null;
  metricsUnavailable: boolean; healthStale: boolean;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  // Keyed on startedAt, so a new run restarts the clock and unmounting (the run
  // finishing or being cancelled) clears the interval.
  useEffect(() => {
    if (startedAt === null) return;
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  const overEstimate = etaSec !== null && elapsedMs / 1000 > etaSec;

  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      className="glass-panel mb-2 rounded-xl px-5 py-4">
      <div className="flex items-center gap-4">
        <span className="font-jetbrains shrink-0 text-[11px] text-cyan-300">rendering</span>
        <div className="flex h-8 flex-1 items-end gap-[2px]" aria-hidden>
          {Array.from({ length: 48 }).map((_, i) => (
            <span key={i} className="eq-bar w-[2px] rounded-full bg-cyan-300/60" style={{ height: "100%", animationDelay: `${(i % 7) * 0.08}s` }} />
          ))}
        </div>
        {/* The one MEASURED number on this row. */}
        <span className="font-jetbrains shrink-0 text-[12px] tabular-nums text-white/85" aria-live="off">
          {fmtElapsed(elapsedMs)}
        </span>
      </div>
      <p className="font-jetbrains mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/55">
        {/* An estimate presented as a measurement is a lie, so it is
            always labelled, always sourced, and when it is exceeded it
            says so instead of stalling at "1s remaining". */}
        {etaSec === null ? (
          <span>{noEtaLabel}</span>
        ) : overEstimate ? (
          <span className="text-amber-200/80">
            Past the ~{etaSec}s estimate — still rendering ({etaBasisLabel}; an estimate, not a measurement of this run).
          </span>
        ) : (
          <span>Estimated ~{etaSec}s for ~{estAudioSec}s of audio — {etaBasisLabel}.</span>
        )}
        {/* An ABSENT queue reading is not an empty queue. The engine gates its
            metrics behind the observability scope (service/app.py::health), so
            a studio with no API key against a keyed backend gets a bare
            {"status":"ready"} — coercing that to 0 made "we cannot see the
            queue" render identically to "the queue is empty", with nothing
            stale about it because the request succeeded. */}
        {metricsUnavailable ? (
          <span className="text-amber-200/70" title="The engine reports queue depth only to callers holding its observability scope — set GRAVITONE_API_KEY for this studio to see it">
            · queue depth unavailable to this studio — this is not a reading of an empty queue
          </span>
        ) : (
          <>
            {queued !== null && queued > 0 && (
              <span title="Jobs waiting for a synthesis worker across the engine">
                · {queued} job{queued === 1 ? "" : "s"} queued ahead of the pool
              </span>
            )}
            {inFlight !== null && inFlight > 0 && <span title="Jobs a worker is synthesizing right now">· {inFlight} rendering</span>}
            {/* Said out loud, so "nothing queued" is an affirmative reading
                rather than the absence of a chip. */}
            {queued === 0 && inFlight === 0 && (
              <span title="The engine reported an empty queue">· queue clear</span>
            )}
          </>
        )}
        {healthStale && <span className="text-amber-200/70">· queue reading is stale</span>}
      </p>
    </motion.div>
  );
}

export default function PlaygroundConsole() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [charId, setCharId] = useState<string>("");
  const [expr, setExpr] = useState<Expression>(DEFAULT_EXPRESSION);
  // Composer mode: Solo = one Character throughout (current flow); Script = a
  // multi-character performance rendered as one take via /v1/performance.
  const [mode, setMode] = useState<"solo" | "script">("solo");
  const [liveOn, setLiveOn] = useState(false);
  const [liveActive, setLiveActive] = useState(false);
  // What the next take is rendered as. It sits beside Generate rather than in
  // the expression panel because it is a decision about the FILE you keep, not
  // about how the voice sounds.
  const [format, setFormat] = useState<OutputFormat>(DEFAULT_OUTPUT_FORMAT);
  const [script, setScript] = useState<ScriptLine[]>([]);
  const [activeLine, setActiveLine] = useState(0); // emotion tags target this line
  const lineRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const scriptSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  // Backpressure (429): engine is up but busy — offer a retry, never fall to
  // the browser voice. null = no pending backpressure.
  const [busyNotice, setBusyNotice] = useState<{ retryAfterSec: number } | null>(null);
  // Seconds left on the backend's Retry-After. The retry button used to fire
  // instantly into the same full queue even though the wait was known.
  const [retryIn, setRetryIn] = useState(0);
  // Render clock: when the in-flight run started, and the ticking elapsed time.
  // A CPU-only render takes seconds or minutes and the console showed the same
  // decorative equalizer for both.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Transient error surface so generation failures are never silent.
  const [toast, setToast] = useState<string | null>(null);
  // What to ANNOUNCE when a render finishes. Nothing announced one: the render
  // clock is deliberately aria-live="off" (it changes four times a second) and
  // the take log is not a live region, so a screen-reader user pressed Generate
  // and then sat in silence — the one thing the whole page exists to tell them
  // was the one thing it never said. Failures already speak: ErrorBanner is
  // role="alert".
  const [announcement, setAnnouncement] = useState("");
  // Why the LAST generation dropped to the browser voice (null = it didn't).
  // Derived from the take list this used to scan for *any* browser take ever
  // made, so the banner stayed pinned across later successful renders and
  // across a session restore.
  const [fallback, setFallback] = useState<{ reason: FallbackReason; detail?: string } | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [codeFor, setCodeFor] = useState<string | null>(null); // take id with the code panel open
  // take id whose punch-in drill-down is open. Editing is opt-in per take: the
  // default card must stay as uncluttered as it was before there was an editor.
  const [punchFor, setPunchFor] = useState<string | null>(null);
  // take id → shared state: publishing / share id / failed
  const [shares, setShares] = useState<Record<string, string | "pending" | "error">>({});
  // Clipboard truth for both copy affordances (per-take share link, keyed by
  // take id; the review link under the key "review"). Published is not the
  // same as copied and the labels must not claim otherwise.
  const { copy, copied, failed: copyFailed } = useCopyFeedback<string>(2500);
  // A take that could not be written to IndexedDB (quota, private mode) is NOT
  // durable — saying nothing would leave the "survives a refresh" promise
  // silently broken.
  const [storageErr, setStorageErr] = useState<string | null>(null);
  // Composer durability. `restored` is what came off disk waiting for the
  // roster (character ids can only be validated against the server's list);
  // `composerErr` reports a composer that is NOT being saved, and
  // `composerNotice` reports work that was restored but had to be repaired.
  const [restored, setRestored] = useState<ComposerState | null>(null);
  const [composerReady, setComposerReady] = useState(false);
  const [composerErr, setComposerErr] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const reconciled = useRef(false);
  // Publish-time consent for PUBLIC re-perform, applied to takes published
  // from here on. Default OFF — see the toggle in the takes-log header.
  const [allowReperform, setAllowReperform] = useState(false);
  // Why publishing a take failed. The button's "✗ failed" says THAT it failed;
  // the backend's own detail (request id included) says what to do about it,
  // and share()'s catch used to throw it away.
  const [shareErr, setShareErr] = useState<string | null>(null);
  // client-review link: selected take ids → /r/{id}
  const [reviewSel, setReviewSel] = useState<Set<string>>(new Set());
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const seq = useRef(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null); // scroll target for "reuse"
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
  // In-flight generation, so it can be cancelled (or aborted on unmount).
  const runRef = useRef<AbortController | null>(null);
  const mounted = useMounted();

  const { playingId, paused, progress, toggle, stop, seekTo } = useAudioPlayer();

  // Engine state BEFORE the user commits to a render. The page most affected by
  // a loading or draining engine used to discover that state only by failing a
  // generate. Same shared poller the benchmarks view uses — faster cadence
  // while a render is in flight so the queue reading stays current.
  const { health, stale: healthStale } = useHealthPoll(busy ? 5_000 : 30_000);
  const engineStatus = health?.status;                       // ready | loading | draining
  // The engine's live metrics are OPTIONAL in the health response: they are
  // gated behind the observability scope, and a studio with no
  // GRAVITONE_API_KEY talking to a keyed backend is a legitimate deployment
  // (web/lib/backend.ts attaches the key only when one is configured). Missing
  // therefore means UNAVAILABLE, never zero — `Number(undefined ?? 0)` turned
  // "we cannot see the queue" into "the queue is empty".
  const metric = (key: string): number | null => {
    const v = health?.metrics?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const queued = metric("queued");
  const inFlight = metric("in_flight");
  // The engine ANSWERED, and told us nothing about its queue. (A backend the
  // studio cannot reach at all is a different sentence, and the engine notice
  // above already says it.)
  const metricsUnavailable =
    !!health && engineStatus !== "unreachable" && queued === null && inFlight === null;
  // null = nothing worth saying. Every string states the CONSEQUENCE of
  // generating right now, which is what the user is about to decide.
  const engineNotice =
    !health ? null
    : engineStatus === "ready" ? null
    : engineStatus === "loading" ? "Gravitone is still loading its model — generating now falls back to your browser voice."
    : engineStatus === "draining" ? "Gravitone is restarting — generating now falls back to your browser voice."
    : "Gravitone backend unreachable — generating now uses your browser voice (metatags ignored).";

  const [preferred, setPreferred] = useState<{ character_id: string | null; picks: number }>({ character_id: null, picks: 0 });

  const [rosterErr, setRosterErr] = useState<string | null>(null);
  useEffect(() => {
    // Two INDEPENDENT reads that used to be awaited one after the other, so the
    // rail waited for a recommendation it does not depend on. They are started
    // together now, and a real AbortController (not just an `alive` flag) means
    // navigating away actually cancels them instead of leaving the requests to
    // finish for a page nobody is looking at.
    const ctrl = new AbortController();
    // The roster goes through the shared data layer; the recommendation is
    // decoration, so its failure degrades to "no recommendation" and never
    // costs the user the rail.
    const rosterP = loadRoster(ctrl.signal);
    const prefP = apiJson<{ character_id: string | null; picks: number }>(
      "/api/reviews/preferred", { cache: "no-store", signal: ctrl.signal }, "no recommendation")
      .catch(() => ({ character_id: null, picks: 0 }));
    (async () => {
      try {
        const [cs, pref] = [await rosterP, await prefP];
        if (!mounted.current || ctrl.signal.aborted) return;
        setCharacters(cs);
        setPreferred(pref);
        setRosterErr(null);
        // Which Character is selected is decided in ONE place below — it now
        // has to reconcile a restored selection against the live roster.
      } catch (e) {
        // An abort is this component going away, not a failed read.
        if (!mounted.current || isAbort(e) || ctrl.signal.aborted) return;
        setCharacters([]);
        setRosterErr(e instanceof Error ? e.message : "could not load characters");
      }
    })();
    return () => ctrl.abort();
  }, [mounted]);

  // ── composer durability ────────────────────────────────────────────────────
  // The take log has survived a refresh since an earlier round; the WORK that
  // produced it did not. Same mechanism (lib/playgroundDb), one store each.

  // A live mirror of the composer, so the restore below can tell whether the
  // user got here first without re-running on every keystroke.
  const live = useRef({ text, script, mode, expr });
  useEffect(() => { live.current = { text, script, mode, expr }; });

  useEffect(() => {
    let cancelled = false;
    loadComposer()
      .then((s) => {
        if (cancelled || !s) return;
        const cur = live.current;
        // Typing (or switching mode) before the restore landed means the user
        // is already working — their input wins over the stored session.
        const pristine = cur.text === DEFAULT_TEXT && cur.script.length === 0
          && cur.mode === "solo" && cur.expr === DEFAULT_EXPRESSION;
        if (!pristine) return;
        setText(s.text);
        setScript(s.script);
        setExpr(s.expr);
        setMode(s.mode);
        setActiveLine(s.activeLine);
        // charId waits for the roster: a stored id may name a Character that
        // has since been deleted (see the reconcile effect).
        setRestored(s);
      })
      .catch((e) => {
        if (cancelled) return;
        const why = e instanceof Error ? e.message : "storage unavailable";
        setComposerErr(`Your last composer session could not be restored (${why}). Anything you write now is also NOT being saved.`);
      })
      // Saving starts only once the restore has settled, so an empty composer
      // can never overwrite the stored one first.
      .finally(() => { if (!cancelled) setComposerReady(true); });
    return () => { cancelled = true; };
  }, []);

  // Persist on a debounce. Saving on every keystroke would put an IndexedDB
  // transaction behind every character typed; 800ms of quiet is the trade.
  useEffect(() => {
    if (!composerReady) return;
    const id = setTimeout(() => {
      void saveComposer({ text, script, expr, mode, charId, activeLine })
        .then(() => { if (mounted.current) setComposerErr(null); })
        .catch((e) => {
          if (!mounted.current) return;
          const why = e instanceof Error ? e.message : "storage unavailable";
          setComposerErr(`Your composer is NOT being saved for after a refresh (${why}).`);
        });
    }, 800);
    return () => clearTimeout(id);
  }, [composerReady, text, script, expr, mode, charId, activeLine, mounted]);

  // The ONE place the selected Character is decided. It reconciles three
  // sources against the live roster: an already-valid selection (the user's own
  // click), a restored session, and the client-approved default. A stored id
  // whose Character was deleted must not leave the rail with nothing selected
  // or a script <select> pointing at a value it does not offer.
  useEffect(() => {
    if (characters.length === 0) return;
    const ids = characters.map((c) => c.character_id);
    const fallback = (preferred.character_id && ids.includes(preferred.character_id)
      ? preferred.character_id
      : ids[0]);
    if (restored && !reconciled.current) {
      reconciled.current = true;
      const { state, dropped } = reconcileCharacters(restored, ids, fallback);
      setCharId(state.charId || fallback);
      setScript(state.script);
      if (dropped.length > 0) {
        const name = characters.find((c) => c.character_id === fallback)?.name ?? fallback;
        setComposerNotice(
          `${dropped.length === 1 ? "A Character" : `${dropped.length} Characters`} in your restored session no longer exist (${dropped.join(", ")}) — those lines now use ${name}. Check them before generating.`,
        );
      }
      return;
    }
    setCharId((cur) => (cur && ids.includes(cur) ? cur : fallback));
  }, [characters, preferred, restored]);

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
      .catch((e) => {
        // A restore that failed is not "no takes yet" — say the log could not
        // be read rather than rendering a false empty state.
        if (cancelled) return;
        const why = e instanceof Error ? e.message : "storage unavailable";
        setStorageErr(`Saved takes from your last session could not be restored (${why}).`);
      });
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
  function onRailKey(e: React.KeyboardEvent<HTMLButtonElement>, i: number) {
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

  const plain = stripTags(text);
  const estSec = Math.max(1.5, Math.round(plain.length * 0.055 * 10) / 10);
  // Script mode: the non-empty lines that will actually be synthesized.
  const scriptLines = useMemo(
    () => script.filter((l) => stripTags(l.text).trim() && l.characterId),
    [script],
  );
  const scriptChars = scriptLines.reduce((n, l) => n + stripTags(l.text).length, 0);

  // The server's limits, stated BEFORE the request (service/app.py's 8000-char
  // and 64-line caps, the proxy's 128 KB body). One pure function so the rule
  // is testable and lives next to the constants it enforces.
  const blocked = useMemo(() => composerLimit({ mode, text, script }), [mode, text, script]);

  const canGenerate = !blocked && (mode === "script" ? scriptLines.length > 0 : (!!plain && !!character));
  // The LAST run decides the notice: a 500 and an unplugged backend both drop
  // to the browser voice, but they are different events — and once a gravitone
  // take succeeds the notice is simply no longer true.
  // --- render estimate ------------------------------------------------------
  // estSec is estimated AUDIO seconds; what the user waits for is COMPUTE
  // seconds. The bridge is the realtime factor (audio produced per second of
  // compute): their own last render first (it measured THIS box under THIS
  // load), the engine's live average second. With neither, there is nothing
  // honest to estimate from and the UI says exactly that rather than inventing
  // a number or drawing a progress bar for work whose progress is unobservable.
  const estAudioSec = mode === "script"
    ? Math.max(1.5, Math.round(scriptChars * 0.055 * 10) / 10)
    : estSec;
  // Only a take whose timing means what this build thinks it means may
  // calibrate an estimate — a record restored from before the wall-clock rtf
  // fix carries a summed per-segment factor that understates the wait
  // (shared.ts::TAKE_TIMING_VERSION).
  const lastRtf = takes.find(isTimingBasis)?.rtf;
  const liveRtfRaw = metric("realtime_factor");
  const liveRtf = liveRtfRaw !== null && liveRtfRaw > 0 ? liveRtfRaw : undefined;
  const rtfBasis = lastRtf ?? liveRtf;
  const etaSec = rtfBasis ? Math.max(1, Math.round(estAudioSec / rtfBasis)) : null;
  const etaBasisLabel = lastRtf
    ? `your last render ran at ${lastRtf}× realtime`
    : liveRtf ? `the engine is averaging ${liveRtf}× realtime` : "";
  // With no basis there is no estimate — but WHY there is none is the honest
  // part. "The first render calibrates one" is untrue when the engine's own
  // average exists and is merely invisible to this studio.
  const noEtaLabel = metricsUnavailable
    ? "No estimate yet — the engine's realtime factor is not visible to this studio, and no render here has calibrated one."
    : "No estimate yet — the first render on this machine is what calibrates one.";

  const fallbackNotice = fallback && (
    fallback.detail
      ? `${FALLBACK_COPY[fallback.reason]} Backend said: ${fallback.detail}`
      : FALLBACK_COPY[fallback.reason]
  );

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
    if (script.length <= 1) return;
    setScript((s) => (s.length <= 1 ? s : s.filter((_, i) => i !== idx)));
    // Compact the ref array with the list. It never was, so after a removal the
    // refs were off by one against the rows and the LAST slot still pointed at
    // a detached textarea — emotion-tag insertion (which reads selectionStart
    // from lineRefs) put the caret in the wrong row.
    lineRefs.current.splice(idx, 1);
    // Removing a line ABOVE the active one shifts the active row down by one;
    // plain clamping (the old code) left activeLine pointing at a DIFFERENT
    // line, so emotion tags landed on a row the user wasn't editing.
    setActiveLine((a) => {
      const shifted = idx < a ? a - 1 : a;
      return Math.max(0, Math.min(shifted, script.length - 2));
    });
  }
  function moveLine(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= script.length) return;
    setScript((s) => {
      const n = [...s];
      [n[idx], n[j]] = [n[j], n[idx]];
      return n;
    });
    // Follow the active row through the swap so tags keep targeting it.
    setActiveLine((a) => (a === idx ? j : a === j ? idx : a));
  }
  /** Switch composer mode, CARRYING the composed text across.
   *
   *  Going to Script used to replace whatever was in the solo composer with a
   *  canned two-line demo — the user's own sentence, tags and all, was simply
   *  gone. The demo now only appears when there is nothing to carry. */
  function switchMode(m: "solo" | "script") {
    if (m === "script") {
      if (script.length === 0) {
        const first = charId || characters[0]?.character_id || "";
        const second = characters.find((c) => c.character_id !== first)?.character_id || first;
        setScript(text.trim()
          ? [newLine(first, text), newLine(second, "")]
          : [
              newLine(first, "Hello there."),
              newLine(second, "[excited]Great to finally meet you![/excited]"),
            ]);
        setActiveLine(0);
      }
    } else if (!text.trim()) {
      // Back to Solo with nothing in it: adopt the line being edited rather
      // than handing the user a blank page they already filled in once.
      const carried = script[activeLine]?.text || script.find((l) => l.text.trim())?.text;
      if (carried) setText(carried);
    }
    setMode(m);
  }

  /** Load a take back into the composer, ready to re-run.
   *
   *  Every take already stores the text, Character and expression that produced
   *  it; without this, acting on "sad → nearest emotion" meant retyping the
   *  prompt from the ribbon. Characters that have since been deleted are
   *  reported, not silently swapped. */
  function reuseTake(t: Take) {
    const ids = characters.map((c) => c.character_id);
    const fallback = (charId && ids.includes(charId) ? charId : ids[0]) ?? "";
    const candidate: ComposerState = t.lines?.length
      ? {
          text, mode: "script", expr: { ...t.expr }, charId: t.characterId, activeLine: 0,
          script: t.lines.map((l, i) => ({
            id: `line-reuse-${t.id}-${i}`, characterId: l.character_id, text: l.text,
          })),
        }
      : { text: t.text, mode: "solo", expr: { ...t.expr }, charId: t.characterId, activeLine: 0, script };
    const { state, dropped } = reconcileCharacters(candidate, ids, fallback);
    setMode(state.mode);
    setText(state.text);
    setScript(state.script);
    setActiveLine(0);
    setExpr(state.expr);
    setCharId(state.charId);
    setComposerNotice(dropped.length > 0
      ? `Loaded into the composer, but ${dropped.join(", ")} no longer exists — those lines now use ${charName(state.charId)}.`
      : null);
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // Coalesce concurrent uploads of the SAME take: share() and ensureShared()
  // share this map, so clicking "share" and then "client review link" before
  // the first upload settles reuses the one in-flight upload instead of minting
  // two /t/{id} pages for one take.
  const inflightUploads = useRef<Map<string, Promise<string>>>(new Map());
  function uploadOnce(t: Take): Promise<string> {
    const existing = inflightUploads.current.get(t.id);
    if (existing) return existing;
    const p = uploadTake(t, { allowReperform }).finally(() => { inflightUploads.current.delete(t.id); });
    inflightUploads.current.set(t.id, p);
    return p;
  }

  /** Copy a share link. useCopyFeedback owns the "did the clipboard accept it"
   *  question (and the timer cleanup) for every copy affordance in the app. */
  async function copyShareLink(takeId: string, shareId: string) {
    await copy(`${window.location.origin}/t/${shareId}`, takeId);
  }

  /** Persist a take server-side, mint its /t/{id} page, copy the link. */
  async function share(t: Take) {
    const existing = shares[t.id];
    if (existing && existing !== "pending" && existing !== "error") {
      // Already published — clicking again just re-copies the link.
      await copyShareLink(t.id, existing);
      return;
    }
    if (!t.url || existing === "pending") return;
    setShares((s) => ({ ...s, [t.id]: "pending" }));
    setShareErr(null);
    try {
      const id = await uploadOnce(t);
      if (!mounted.current) return;
      setShares((s) => ({ ...s, [t.id]: id }));
      await copyShareLink(t.id, id);
    } catch (e) {
      if (!mounted.current) return;
      setShares((s) => ({ ...s, [t.id]: "error" }));
      setShareErr(e instanceof Error && e.message
        ? `This take could not be published — ${e.message}`
        : "This take could not be published. The take itself is safe in your log.");
      // The "✗ failed" chip clears itself — see the effect below, which owns
      // the timer.
    }
  }

  // Let a failed share chip fade back to "↗ share" so the button is offerable
  // again. This used to be a bare setTimeout inside share()'s catch: no cleanup
  // and no `mounted.current` check, so navigating away left a timer holding a
  // setState on a dead component (every other async path in this file guards).
  // As an effect, React cancels it on unmount and on the next change for free.
  const erroredShares = Object.entries(shares)
    .filter(([, v]) => v === "error").map(([id]) => id).sort().join(" ");
  useEffect(() => {
    if (!erroredShares) return;
    const ids = erroredShares.split(" ");
    const timer = setTimeout(() => {
      setShares((s) => {
        const next = { ...s };
        // Only clear what is STILL failed — a retry that has since gone pending
        // or succeeded must not be reset by an older timer.
        for (const id of ids) if (next[id] === "error") delete next[id];
        return next;
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [erroredShares]);

  /** Publish a take if needed and return its share id (the review needs one). */
  async function ensureShared(t: Take): Promise<string> {
    const existing = shares[t.id];
    if (existing && existing !== "pending" && existing !== "error") return existing;
    // "pending" falls through to uploadOnce, which returns the in-flight
    // share() upload rather than starting a duplicate one.
    const id = await uploadOnce(t);
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
      const j = await apiJson<{ review_id: string }>("/api/reviews", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${chosen[0].characterName} — pick a take`, take_ids: ids }),
      }, "could not create the review");
      if (!mounted.current) return;
      const url = `${window.location.origin}/r/${j.review_id}`;
      setReviewUrl(url);
      setReviewSel(new Set());
      // The banner reports the copy's TRUE outcome (see reviewUrl below) — it
      // used to claim "✓ review link copied" after a swallowed rejection.
      await copy(url, "review");
    } catch (e) {
      if (!mounted.current) return;
      setReviewErr(e instanceof Error ? e.message : "could not create the review");
    } finally { if (mounted.current) setReviewBusy(false); }
  }

  /** Put a take in the log NOW, then refine its waveform.
   *
   *  Peak extraction decodes the whole WAV; doing it inside synthesis meant the
   *  take could not appear until a main-thread decode finished, for a
   *  decoration. The take is shown with its synthetic bars, the real ones swap
   *  in when the decode lands, and a decode that fails simply leaves the
   *  synthetic bars (the same degrade as before). Persistence waits for that
   *  settle so the stored take carries its final waveform. */
  function addTake(take: Take) {
    setTakes((t) => [take, ...t]);
    // The count makes each message distinct, so two identical takes in a row
    // are both announced (a live region ignores an unchanged string).
    const n = takesRef.current.length + 1;
    setAnnouncement(
      take.mode === "browser"
        ? `Browser-voice take ready — ${take.seconds} seconds from ${take.characterName}, Gravitone was not used. ${n} take${n === 1 ? "" : "s"} in the log.`
        : `Take ready — ${take.seconds} seconds of audio from ${take.characterName}. ${n} take${n === 1 ? "" : "s"} in the log.`,
    );
    if (!take.blob) { void persistTake(take); return; }
    void refinePeaks(take.blob).then((p) => {
      const finished: Take = p
        // X-Audio-Seconds is authoritative; the decoded duration only fills in
        // when the backend did not report one.
        ? { ...take, peaks: p.peaks, seconds: take.seconds || Math.round(p.duration * 10) / 10 }
        : take;
      if (mounted.current && p) {
        setTakes((list) => list.map((t) => (t.id === take.id ? { ...t, peaks: finished.peaks, seconds: finished.seconds } : t)));
      }
      void persistTake(finished);
    });
  }

  /** Persist a take (audio blob + metadata) so it survives a refresh.
   *  A failure here (quota exceeded, storage blocked) does not lose the take —
   *  but it DOES break the durability the log promises, so it is reported
   *  rather than swallowed. */
  async function persistTake(t: Take) {
    try {
      // The take already holds its blob (engine.ts carries it through); this
      // used to fetch the take's own object URL to get the same bytes back.
      await putTake(t, t.blob ?? null);
      if (mounted.current) setStorageErr(null);
    } catch (e) {
      if (!mounted.current) return;
      const why = e instanceof Error ? e.message : "storage unavailable";
      setStorageErr(`This take is in the log but could NOT be saved for after a refresh (${why}). Download the wav to keep it.`);
    }
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
    setPunchFor((p) => (p === id ? null : p));
    setShares((s) => { const { [id]: _, ...rest } = s; return rest; });
    void deleteTake(id);
    // A deleted take's audition lanes are orphaned audio — the one thing the
    // variant store must never accumulate.
    void dropVariants(id);
  }

  /**
   * Commit a punched region: the spliced master becomes a NEW take.
   *
   * The original is untouched and stays in the log — an editor that overwrites
   * the thing you were comparing against is not an editor. The new take inherits
   * the base's identity (Character, script, text) and carries `edits`, so its
   * code export prints the base call plus every patch call (see TakeCode).
   */
  function commitPunch(base: Take, p: CommitPayload) {
    seq.current += 1;
    const take: Take = {
      ...base,
      id: `take-${Date.now()}-${seq.current}`,
      url: URL.createObjectURL(p.blob),
      blob: p.blob,
      peaks: p.peaks,
      seconds: p.seconds,
      kb: Math.round(p.blob.size / 1024),
      // A splice has no whole-call realtime factor to report: part of this audio
      // was rendered minutes ago. Reporting the patch render's rtf as the take's
      // would let a one-segment render calibrate the estimate for a whole take,
      // so the timing fields carry ONLY what was measured (the patch), rtf stays
      // 0 and no timingVersion is stamped — isTimingBasis therefore skips it.
      rtf: 0,
      synthSeconds: p.synthSeconds,
      queueSeconds: p.queueSeconds,
      timingVersion: undefined,
      segments: p.segments,
      // The master is always wav (engine.spliceRegion), whatever the base was.
      format: DEFAULT_OUTPUT_FORMAT,
      createdAt: Date.now(),
      edits: appendEdit(base, p.region),
      // Whatever made the BASE fall back is not a property of this splice.
      fallbackReason: undefined,
      fallbackDetail: undefined,
    };
    addTake(take);
    // addTake's generic announcement is true but says nothing about the edit,
    // which is the whole event here.
    setAnnouncement(
      `Punched take ready — segment ${p.region.i + 1} replaced, ${take.seconds} seconds total. ` +
      `The original take is still in the log.`,
    );
    // Keep the editor open on the RESULT: the loop this feature exists for is
    // fix, listen, fix the next one.
    setPunchFor(take.id);
  }

  /** Start a cancellable run, replacing any previous controller.
   *  CPU synthesis of a long script can take minutes on a loaded box; without
   *  a cancel the user can only wait or reload (HeroMicDemo added an abort for
   *  this exact backend — the playground, where people generate repeatedly,
   *  had none). */
  function newRun(): AbortController {
    const ctrl = new AbortController();
    runRef.current = ctrl;
    return ctrl;
  }

  /** Abort the in-flight generation. */
  function cancelGenerate() {
    runRef.current?.abort();
    runRef.current = null;
  }

  // Abort on unmount too: navigating away should not leave a synthesis
  // request holding a worker slot for a page nobody is looking at.
  useEffect(() => () => runRef.current?.abort(), []);

  // Count the backend's Retry-After down so the retry button can wait for it.
  useEffect(() => {
    if (!busyNotice) { setRetryIn(0); return; }
    setRetryIn(busyNotice.retryAfterSec);
    const id = setInterval(() => setRetryIn((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [busyNotice]);

  /** Every generation starts from a clean slate of notices — a warning about
   *  the PREVIOUS run must never be read as a verdict on this one. */
  function clearNotices() {
    setBusyNotice(null);
    setToast(null);
    setFallback(null);
    setAnnouncement("");        // the PREVIOUS take's announcement is spent
    setStartedAt(Date.now());   // starts the render clock for this run
  }

  /** Report a generation failure with what the backend actually said. Errors
   *  from the apiFetch contract carry the sanitized `detail` (request id
   *  included), which is exactly what support needs and what the old single
   *  generic sentence destroyed. */
  function reportFailure(e: unknown) {
    const detail = e instanceof Error && e.message ? e.message : null;
    setToast(detail ? `Generation failed — ${detail}` : "Generation failed — the backend returned an error. Please try again.");
  }

  /** Dispatch to the active composer mode; wired to ⌘↵ and the retry button. */
  function generate() {
    if (mode === "script") void generateScript();
    else void generateSolo();
  }

  async function generateScript() {
    if (busy || scriptLines.length === 0) return;
    setBusy(true);
    clearNotices();
    const lines: PerfLine[] = scriptLines.map((l) => ({ character_id: l.characterId, text: l.text.trim() }));
    const ctrl = newRun();
    try {
      const r = await perform(lines, expr, ctrl.signal, format);
      if (!mounted.current) return;
      seq.current += 1;
      const distinct = [...new Set(lines.map((l) => l.character_id))];
      const label = distinct.length === 1 ? charName(distinct[0]) : `Ensemble · ${distinct.length} voices`;
      const transcript = lines.map((l) => `${charName(l.character_id)}: ${stripTags(l.text)}`).join("  ·  ");
      const take: Take = {
        id: `take-${Date.now()}-${seq.current}`, text: transcript,
        characterId: lines[0].character_id, characterName: label,
        mode: r.mode, fallbackReason: r.fallbackReason, fallbackDetail: r.fallbackDetail,
        url: r.url, blob: r.blob, peaks: r.peaks, seconds: r.seconds, kb: r.kb, rtf: r.rtf,
        synthSeconds: r.synthSeconds, queueSeconds: r.queueSeconds,
        ignoredSettings: r.ignoredSettings, segments: r.segments, reportCorrupt: r.reportCorrupt,
        expr: { ...expr },
        createdAt: Date.now(), format: r.format, lines,
        timingVersion: TAKE_TIMING_VERSION,
      };
      addTake(take);
      setFallback(r.mode === "browser" ? { reason: r.fallbackReason ?? "unreachable", detail: r.fallbackDetail } : null);
    } catch (e) {
      if (!mounted.current) return;
      if (isAbort(e)) { /* user cancelled — no take, no error */ }
      else if (e instanceof EngineBusyError) setBusyNotice({ retryAfterSec: e.retryAfterSec });
      else reportFailure(e);
    } finally { if (mounted.current) setBusy(false); }
  }

  async function generateSolo() {
    if (!plain || busy || !character) return;
    setBusy(true);
    clearNotices();
    const ctrl = newRun();
    try {
      const r = await speak(text, character.character_id, expr, ctrl.signal, format);
      if (!mounted.current) return;
      seq.current += 1;
      // Timestamped id so restored takes (which keep their stored ids) never
      // collide with freshly generated ones.
      const take: Take = {
        id: `take-${Date.now()}-${seq.current}`, text: text.trim(),
        characterId: character.character_id, characterName: character.name,
        mode: r.mode, fallbackReason: r.fallbackReason, fallbackDetail: r.fallbackDetail,
        url: r.url, blob: r.blob, peaks: r.peaks, seconds: r.seconds, kb: r.kb, rtf: r.rtf,
        synthSeconds: r.synthSeconds, queueSeconds: r.queueSeconds,
        ignoredSettings: r.ignoredSettings, segments: r.segments, reportCorrupt: r.reportCorrupt,
        expr: { ...expr },
        createdAt: Date.now(), format: r.format,
        timingVersion: TAKE_TIMING_VERSION,
      };
      addTake(take);
      setFallback(r.mode === "browser" ? { reason: r.fallbackReason ?? "unreachable", detail: r.fallbackDetail } : null);
    } catch (e) {
      if (!mounted.current) return;
      // Backpressure keeps the engine reachable — offer a retry. Anything else
      // (a gone Character, an unexpected throw) is a genuine failure that must
      // be visible, in the backend's own words.
      if (isAbort(e)) {
        // The user pressed Cancel: not a failure, so no toast and no take.
      } else if (e instanceof EngineBusyError) {
        setBusyNotice({ retryAfterSec: e.retryAfterSec });
      } else {
        reportFailure(e);
      }
    } finally { if (mounted.current) setBusy(false); }
  }

  return (
    <div className="pb-24">
      {/* The completion announcement. A take arriving is a visual-only event —
          a new card slides into a log that is not a live region — so this is
          the only thing that tells a screen-reader user their render finished. */}
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
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
        <span className="text-white">Voices</span> mid-sentence. A missing emotion uses the nearest
        recorded one, and only then baseline.
      </p>

      {rosterErr && <ErrorBanner>{rosterErr}</ErrorBanner>}

      {/* The take exists but is degraded → warning (amber). */}
      {fallbackNotice && <ErrorBanner severity="warning">{fallbackNotice}</ErrorBanner>}

      {storageErr && <ErrorBanner severity="warning">{storageErr}</ErrorBanner>}

      {/* The composer is not durable right now — say so while there is still
          time to copy the text out. */}
      {composerErr && <ErrorBanner severity="warning">{composerErr}</ErrorBanner>}

      {/* Restored (or reused) work that had to be repaired: a Character it
          named is gone. Dismissible — it is about one action, not a state. */}
      {composerNotice && (
        <ErrorBanner severity="warning">
          <span className="flex items-center justify-between gap-3">
            <span>{composerNotice}</span>
            <button onClick={() => setComposerNotice(null)} aria-label="Dismiss" className="shrink-0 text-amber-200/70 transition hover:text-amber-100">✕</button>
          </span>
        </ErrorBanner>
      )}

      {/* Publishing failed: nothing was created, so this is an error, not a
          degraded success. */}
      {shareErr && (
        <ErrorBanner>
          <span className="flex items-center justify-between gap-3">
            <span>{shareErr}</span>
            <button onClick={() => setShareErr(null)} aria-label="Dismiss" className="shrink-0 text-rose-200/70 transition hover:text-rose-100">✕</button>
          </span>
        </ErrorBanner>
      )}

      {busyNotice && (
        <ErrorBanner severity="warning">
          <span className="flex flex-wrap items-center justify-between gap-3">
            <span>
              Engine busy — the render queue is full.{" "}
              {retryIn > 0 ? `The backend asked for ${retryIn}s before the next attempt.` : "You can retry now."}
            </span>
            {/* Retrying inside the backend's own Retry-After window just adds
                another rejection to the same full queue. */}
            <button
              onClick={() => void generate()}
              disabled={busy || retryIn > 0}
              title={retryIn > 0 ? `The backend asked for ${retryIn}s more` : "Retry this generation"}
              className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-amber-100 transition hover:bg-amber-400/20 disabled:opacity-40"
            >
              {busy ? "retrying…" : retryIn > 0 ? `↻ retry in ${retryIn}s` : "↻ retry"}
            </button>
          </span>
        </ErrorBanner>
      )}

      {/* Engine state the user should know BEFORE pressing Generate. Suppressed
          while a fallback notice is up — that one already reports the outcome. */}
      {!fallbackNotice && engineNotice && (
        <ErrorBanner severity="warning">
          {engineNotice}
          {healthStale && " (engine status may be out of date — the studio cannot reach it right now.)"}
        </ErrorBanner>
      )}

      {/* Nothing was produced → error (rose). */}
      {toast && (
        <ErrorBanner>
          <span className="flex items-center justify-between gap-3">
            <span>{toast}</span>
            <button onClick={() => setToast(null)} aria-label="Dismiss" className="shrink-0 text-rose-200/70 transition hover:text-rose-100">✕</button>
          </span>
        </ErrorBanner>
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
              <button key={c.character_id} onClick={() => setCharId(c.character_id)} aria-pressed={on}
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

      <div className="mt-6 grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
        {/* compose bay */}
        <div ref={composerRef} className="glass-panel rounded-2xl">
          <div className="font-jetbrains flex items-center justify-between border-b border-white/8 px-5 py-2.5 text-[11px] uppercase tracking-widest text-white/60">
            <div className="flex items-center gap-1">
              {(["solo", "script"] as const).map((m) => (
                <button key={m} onClick={() => switchMode(m)} aria-pressed={mode === m}
                  title={m === "solo" ? "One Character throughout" : "A multi-character performance in one take"}
                  className={`rounded-full border px-2.5 py-0.5 transition ${mode === m ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200" : "border-transparent text-white/50 hover:text-white/80"}`}>
                  {m}
                </button>
              ))}
              <button onClick={() => setLiveOn((v) => !v)} aria-pressed={liveOn}
                title="Talk to this Character in real time — every turn becomes a take"
                className={`rounded-full border px-2.5 py-0.5 transition ${liveOn ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200" : "border-transparent text-white/50 hover:text-white/80"}`}>
                live
              </button>
            </div>
            {/* The counter states the REAL ceiling, and turns as the text
                approaches it — the limit used to be discovered by a rejected
                render. */}
            <span className={blocked ? "text-rose-300" : (mode === "solo" && text.length > MAX_TEXT_CHARS * 0.9) ? "text-amber-200/90" : ""}>
              {mode === "script"
                ? `${scriptChars} chars · ${scriptLines.length}/${MAX_SCRIPT_LINES} line${scriptLines.length === 1 ? "" : "s"}`
                : `${text.length.toLocaleString()}/${MAX_TEXT_CHARS.toLocaleString()} chars · ~${estSec}s audio`}
            </span>
          </div>

          {mode === "solo" ? (
            <textarea ref={areaRef} value={text} onChange={(e) => setText(e.target.value)}
              aria-invalid={text.length > MAX_TEXT_CHARS}
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
                    aria-invalid={line.text.length > MAX_TEXT_CHARS}
                    placeholder="Line text… tag with [emotion]…[/emotion] to switch this Character's Voices"
                    className="font-hanken w-full resize-none bg-transparent text-sm leading-relaxed text-white placeholder:text-white/40 focus:outline-none" />
                  {line.text.length > MAX_TEXT_CHARS && (
                    <p className="font-jetbrains mt-1 text-[11px] text-rose-300">
                      {line.text.length.toLocaleString()}/{MAX_TEXT_CHARS.toLocaleString()} characters — this line is too long to render.
                    </p>
                  )}
                </div>
              ))}
              <button onClick={addLine} disabled={script.length >= MAX_SCRIPT_LINES}
                title={script.length >= MAX_SCRIPT_LINES
                  ? `A performance renders at most ${MAX_SCRIPT_LINES} lines in one call`
                  : "Add a line to the script"}
                className="font-jetbrains w-full rounded-xl border border-dashed border-white/15 py-2 text-[11px] text-white/60 transition enabled:hover:border-cyan-400/40 enabled:hover:text-cyan-200 disabled:opacity-40">
                {script.length >= MAX_SCRIPT_LINES ? `line limit reached (${MAX_SCRIPT_LINES})` : "+ add line"}
              </button>
            </div>
          )}

          {mode === "solo" && (
            <details className="border-t border-white/8 px-5 py-3">
              <summary className="font-jetbrains cursor-pointer text-[11px] uppercase tracking-widest text-white/60">score — direct emotion by dragging spans</summary>
              <ScoreEditor value={text} onChange={setText} characterId={charId} expr={expr}
                available={character?.emotions ?? []} scale={scale} className="mt-3" />
            </details>
          )}

          {mode === "script" && script.length > 0 && (
            <details className="border-t border-white/8 px-5 py-3">
              <summary className="font-jetbrains cursor-pointer text-[11px] uppercase tracking-widest text-white/60">score — the scene as stacked lanes</summary>
              <ScriptScore lines={script} activeLineId={script[activeLine]?.id} scale={scale} className="mt-3"
                onChangeLine={(id, next) => updateLine(script.findIndex((l) => l.id === id), { text: next })}
                characterName={charName}
                availableFor={(id) => characters.find((c) => c.character_id === id)?.emotions ?? []}
                onFocusLine={(_id, i) => { setActiveLine(i); lineRefs.current[i]?.focus(); }} />
            </details>
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
                    title={has ? `${e.label} — available` : `${e.label} — not recorded: the nearest recorded emotion is used, then baseline`}
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
            <span className={`font-jetbrains text-[11px] ${blocked ? "text-rose-300" : "text-white/60"}`}>
              {blocked
                ? blocked
                : mode === "script" ? "⌘↵ · one take from the whole script" : "⌘↵ to generate"}
            </span>
            <div className="flex items-center gap-2">
              <div role="group" aria-label="Export format"
                className="flex items-center gap-0.5 rounded-lg border border-white/12 p-0.5">
                {OUTPUT_FORMATS.map((f) => (
                  <button key={f.id} onClick={() => setFormat(f.id)} title={f.hint}
                    aria-pressed={format === f.id}
                    className={`font-jetbrains cursor-pointer rounded-md px-2 py-1 text-[11px] transition ${
                      format === f.id ? "bg-cyan-400/15 text-cyan-200" : "text-white/55 hover:text-white/85"
                    }`}>
                    {f.label}
                  </button>
                ))}
              </div>
              {busy && (
                <button
                  onClick={cancelGenerate}
                  className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-rose-400/40 hover:text-rose-200"
                >
                  cancel
                </button>
              )}
              <Button onClick={generate} disabled={busy || liveActive || !canGenerate}
                title={blocked ?? (canGenerate ? "Render this take" : "Write something to render")}>
                {busy ? "Rendering…" : "Generate ▶"}
              </Button>
            </div>
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

      {liveOn && (
        <LiveStage characters={characters} charId={charId} generateBusy={busy} onTake={addTake}
          onScript={(lines) => { setScript(lines); setMode("script"); }} scriptLines={script}
          onActiveChange={setLiveActive} />
      )}

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
            {/* Publish-time consent for public re-perform. OFF by default and
                deliberately so: a fork puts NEW WORDS in this Character's
                voice and spends the box's CPU for a stranger. */}
            <label className="flex cursor-pointer items-center gap-2 normal-case tracking-normal text-white/55"
              title="Let visitors edit the text on the share page and re-render it in this Character's voice (rate-limited, and their fork cannot be forked again)">
              <input type="checkbox" checked={allowReperform}
                onChange={(e) => setAllowReperform(e.target.checked)}
                className="h-3 w-3 accent-cyan-300" />
              allow re-perform <span className="text-white/35">(visitors can re-render new words in this voice)</span>
            </label>
            <span>{takes.length}</span>
          </div>
        </div>

        {reviewUrl && (
          <p className="font-jetbrains mb-3 rounded-lg border border-emerald-400/25 bg-emerald-400/5 px-4 py-2 text-[11px] text-emerald-200/90">
            {/* The link is created either way; only the CLIPBOARD's outcome
                varies, and claiming "copied" after a refusal left users pasting
                whatever was there before. */}
            {copyFailed === "review"
              ? "Review link created — your browser blocked the clipboard, so copy it here: "
              : copied === "review"
                ? "✓ review link copied — "
                : "Review link created — "}
            <a href={reviewUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{reviewUrl}</a>{" "}
            (no login; the client picks one take)
            {copied !== "review" && copyFailed !== "review" && (
              <button onClick={() => void copy(reviewUrl, "review")} className="ml-2 underline underline-offset-2">copy</button>
            )}
          </p>
        )}
        {reviewErr && <ErrorBanner className="mb-3">{reviewErr}</ErrorBanner>}

        {takes.length === 0 && !busy && (
          <div className="rounded-2xl border border-dashed border-white/10 px-5 py-10 text-center text-sm text-white/60">
            No takes yet — compose above and hit Generate.
          </div>
        )}

        <AnimatePresence initial={false}>
          {busy && (
            <RenderStatus key="rendering" startedAt={startedAt} etaSec={etaSec}
              estAudioSec={estAudioSec} etaBasisLabel={etaBasisLabel} noEtaLabel={noEtaLabel}
              queued={queued} inFlight={inFlight}
              metricsUnavailable={metricsUnavailable} healthStale={healthStale} />
          )}

          {takes.map((t) => {
            const isCurrent = playingId === t.id;
            // Punch-in provenance. Absent on every take that was rendered in one
            // call, and on every record stored before the editor existed.
            const edits = readEdits(t);
            return (
              <motion.div key={t.id} layout initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: EASE }} className="glass-panel mb-2 rounded-xl px-5 py-4">
                <div className="flex items-center gap-3">
                  {/* compare selector — 2+ takes become a client review link */}
                  <input
                    type="checkbox"
                    checked={reviewSel.has(t.id)}
                    disabled={t.mode === "browser" || formatMeta(t.format).ext !== "wav"}
                    onChange={(e) =>
                      setReviewSel((s) => {
                        const n = new Set(s);
                        if (e.target.checked) { if (n.size < 6) n.add(t.id); } else n.delete(t.id);
                        return n;
                      })
                    }
                    title={t.mode === "browser" ? "Browser-fallback take — cannot be reviewed"
                      : formatMeta(t.format).ext !== "wav"
                        ? "Review links host wav takes — re-render this take as wav to include it"
                        : "Select for a client review link (max 6)"}
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
                    disabled={t.mode === "browser" || shares[t.id] === "pending" || formatMeta(t.format).ext !== "wav"}
                    title={t.mode === "browser" ? "Browser-speech fallback — nothing to share"
                      : formatMeta(t.format).ext !== "wav"
                        ? "Voice Cards are published as wav — re-render this take as wav to share it at a /t/… link"
                        : "Publish this take at a public /t/… link (copies the URL)"}
                    className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/80 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-white/50"
                  >
                    {shares[t.id] === "pending" ? "sharing…"
                      : shares[t.id] === "error" ? "✗ failed"
                      : shares[t.id] && copyFailed === t.id ? "published — copy failed"
                      : shares[t.id] && copied === t.id ? "✓ link copied"
                      : shares[t.id] ? "↗ copy link"
                      : "↗ share"}
                  </button>
                  <button
                    onClick={() => reuseTake(t)}
                    title="Load this take's text, Character and expression back into the composer"
                    className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/80 transition hover:border-cyan-400/40 hover:text-cyan-200"
                  >
                    ↺ reuse
                  </button>
                  {/* The editor's entry point. Collapsed by default — the card
                      is a log row until the user asks to edit it. */}
                  <button
                    onClick={() => setPunchFor((p) => (p === t.id ? null : t.id))}
                    disabled={t.mode === "browser" || !t.blob}
                    title={t.mode === "browser" || !t.blob
                      ? "Browser-speech fallback take — there is no audio to edit"
                      : "Show the segment timeline: hear a region, retake just that region"}
                    aria-expanded={punchFor === t.id}
                    className={`font-jetbrains shrink-0 rounded-lg border px-3 py-1.5 text-[11px] transition ${
                      punchFor === t.id
                        ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                        : "border-white/15 text-white/80 hover:bg-white/5 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-white/50"
                    }`}
                  >
                    ⌗ timeline
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
                    <a href={t.url} download={`gravitone-${t.characterId}-${t.id}.${formatMeta(t.format).ext}`}
                      title={`Download this take as ${formatMeta(t.format).ext}`}
                      className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/80 transition hover:bg-white/5">↓ {formatMeta(t.format).ext}</a>
                  ) : (
                    <span title="Connect a Gravitone endpoint to export audio"
                      className="font-jetbrains shrink-0 cursor-not-allowed rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-white/50">↓ {formatMeta(t.format).ext}</span>
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

                {/* Punch-in drill-down: the segment timeline plus the retake
                    lanes for whichever region is selected. */}
                {punchFor === t.id && (
                  <PunchIn
                    take={t}
                    characters={characters}
                    charName={charName}
                    playing={isCurrent}
                    progress={isCurrent ? progress : 0}
                    onSeek={(seconds) => { void seekTo(t, seconds); }}
                    onCommit={(p) => commitPunch(t, p)}
                    onStorageError={setStorageErr}
                    engineBusy={busy}
                  />
                )}

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

                {/* This take is an EDIT of another one. Said out loud, because
                    its one-line preview below is the base take's transcript —
                    the exact text the base call still reproduces — while its
                    audio has these regions replaced (the timeline shows them). */}
                {edits && edits.regions.length > 0 && (
                  <p className="font-jetbrains mt-3 inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-cyan-400/20 bg-cyan-400/5 px-2.5 py-1 text-[11px] text-cyan-200/85">
                    <span aria-hidden>✎</span>
                    punched · segment{edits.regions.length === 1 ? "" : "s"}{" "}
                    {edits.regions.map((r) => r.i + 1).join(", ")} re-rendered and spliced
                    <span className="text-white/40">·</span>
                    <span className="text-white/55">base {edits.source}</span>
                  </p>
                )}

                {/* The engine DID report its segments and this build could not
                    read the header. Without this, that take draws exactly like
                    a one-segment take: no ribbon, no rail, no substitution
                    notice — and nothing on screen to say the difference. The
                    audio is untouched and correct; only the report is lost. */}
                {t.reportCorrupt && (
                  <p className="font-jetbrains mt-3 inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-1 text-[11px] text-amber-200/85">
                    <span aria-hidden>⚠</span>
                    the engine&apos;s per-segment report could not be read — the audio is complete,
                    but this take&apos;s emotion breakdown is missing (it is not a single-segment take).
                  </p>
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
