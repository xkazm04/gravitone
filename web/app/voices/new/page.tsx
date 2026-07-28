"use client";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import AppFrame from "@/components/ui/AppFrame";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import EmotionArt from "@/components/ui/EmotionArt";
import { apiJson, readDetail } from "@/lib/apiFetch";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import { useAuth } from "@/lib/useAuth";
import { useMounted } from "@/lib/useMounted";
import { recordVoiceOwnership } from "@/lib/voiceVault";
import { CONSENT_STATEMENT } from "@/lib/consent";
import WaveformLab from "./_loaders/WaveformLab";
import { DetectionFinding, SovereignLimits, segmentFailureNote, type LoaderData } from "./_loaders/shared";
import {
  reducer, initialState, POLLING_PHASES,
  type Character, type Job, type ModeInfo,
} from "./_state/machine";
import {
  ACCEPT_ATTR, LIMITS_HINT, checkBytes, checkDuration,
} from "./_state/uploadLimits";
import { useIngestJob } from "./_state/useIngestJob";

// Phases where a scanned recording is on screen and the mode that produced it
// is still load-bearing for what the user is reading.
const SCAN_PHASES: ReadonlySet<string> = new Set(["processing", "speaker", "review"]);

// Which mutating call is in flight. `submitting` (a ref) still owns the atomic
// double-submit gate; this is the same fact made VISIBLE — a ref cannot put a
// button into a pending state, and the scan kickoff is allowed 120 seconds.
type Pending = null | "scan" | "commit" | `speaker:${string}`;

// Backpressure, not failure: /scan, /speaker and /commit all pass through the
// ingest admission gate (service/ingest_api.py::_admit), which answers 429 when
// too many recordings are already being processed. Same shape the playground
// uses for the engine's 429 (PlaygroundConsole busyNotice + Retry-After
// countdown) — amber, with a retry that waits out the backoff window.
type Backpressure = {
  detail: string;
  retryAfterSec: number;
  stated: boolean;   // did the response actually carry a Retry-After?
  action: { kind: "scan" } | { kind: "speaker"; sid: string } | { kind: "commit" };
};

/** Retry-After (delta-seconds form) → a number; 1s when it is absent/bad. */
function retryAfterOf(r: Response): { sec: number; stated: boolean } {
  const raw = r.headers.get("Retry-After");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? { sec: Math.ceil(n), stated: true }
    : { sec: 1, stated: false };
}

export default function NewCharacterPage() {
  const { user } = useAuth();

  // The whole create-flow state graph in one reducer.
  const [state, dispatch] = useReducer(reducer, initialState);
  const { phase, jobId, job, result, selected, error,
    mode, charName, extendCid, committedCid, created } = state;

  // Ephemeral input/UI state — not part of the flow's state graph.
  const [consented, setConsented] = useState(false); // Voice Vault attestation
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  // auto = cloud quality when the backend has API keys, else local.
  // sovereign = force local-only: the recording never leaves the machine.
  const [ingestMode, setIngestMode] = useState<"auto" | "sovereign">("auto");
  const [characters, setCharacters] = useState<Character[]>([]);
  // What the BACKEND says each mode does — including which mode `auto` resolves
  // to on this box. The panel below states sovereign's limits from this, never
  // from a copy of the constant kept over here.
  const [modeInfo, setModeInfo] = useState<ModeInfo | null>(null);
  const [modeInfoFailed, setModeInfoFailed] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const submitting = useRef(false); // re-entrancy guard for scan/speaker/commit
  const [pending, setPending] = useState<Pending>(null); // the same fact, visible
  const [playing, setPlaying] = useState<string | null>(null);
  const mounted = useMounted();

  // 429 from the ingest admission gate. Recoverable, so it never becomes the
  // rose `error` — a full queue is "try again in a moment", not "it failed".
  const [busyNotice, setBusyNotice] = useState<Backpressure | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  useEffect(() => {
    if (!busyNotice) { setRetryIn(0); return; }
    setRetryIn(busyNotice.retryAfterSec);
    const id = setInterval(() => setRetryIn((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [busyNotice]);

  // Cloneable characters change rarely; fetch on mount — plus once more when a
  // commit completes, so "scan another" offers the just-created character by
  // name in the extend dropdown instead of a stale list.
  const atUpload = phase === "upload";
  const atComplete = phase === "complete";
  useEffect(() => {
    if (!atUpload && !atComplete) return;
    let alive = true;
    void apiJson<(Character & { category: string })[]>(
      "/api/characters", { cache: "no-store" }, "could not load characters")
      .then((cs) => { if (alive) setCharacters(cs.filter((c) => c.category === "cloned")); })
      // The extend dropdown is optional here — the create flow still works
      // without it, so a failure degrades quietly rather than blocking upload.
      .catch(() => { if (alive) setCharacters([]); });
    return () => { alive = false; };
  }, [atUpload, atComplete]);

  // Mode descriptions are backend constants — fetch once. A failure is SAID
  // (the panel can't invent the limits), never swallowed into silence.
  useEffect(() => {
    let alive = true;
    void apiJson<ModeInfo>("/api/ingest/modes", { cache: "no-store" },
      "could not load ingest modes")
      .then((m) => { if (alive) { setModeInfo(m); setModeInfoFailed(false); } })
      .catch(() => { if (alive) setModeInfoFailed(true); });
    return () => { alive = false; };
  }, []);

  // ONE poller for both the analyze leg and the commit leg.
  const [pollStalled, setPollStalled] = useState(false);
  useIngestJob({
    jobId,
    enabled: POLLING_PHASES.has(phase),
    onJob: (j: Job) => dispatch({ type: "JOB_POLLED", job: j }),
    onExpired: () => dispatch({ type: "JOB_EXPIRED" }),
    onStalled: setPollStalled,
  });
  // Reset the degraded-connection notice whenever polling stops/starts.
  useEffect(() => { setPollStalled(false); }, [jobId, phase]);

  // Record Voice Vault ownership exactly once, when the commit completes.
  const recorded = useRef(false);
  const [vaultWarn, setVaultWarn] = useState(false);
  useEffect(() => {
    if (phase === "upload") { recorded.current = false; setVaultWarn(false); return; }
    if (phase !== "complete" || recorded.current) return;
    const pending = state.pendingCommit;
    // Only consume the one-shot once we actually have BOTH the auth'd user and
    // the committed voices. A "complete" render that lands before Firebase's
    // onAuthStateChanged resolves `user` must not latch, or the consent record
    // is dropped; the effect re-runs when `user` populates and completes it.
    if (user && pending && created.length) {
      recorded.current = true;
      void recordVoiceOwnership(user, created.map((v) => ({
        voice_id: v.voice_id, character_id: pending.cid,
        character_name: pending.character, emotion: v.emotion,
      })), "ingested").then((res) => { if (res.failed > 0) setVaultWarn(true); });
    }
  }, [phase, user, created, state.pendingCommit]);

  /** Present a 429 as backpressure. Never touches `error` — that is rose. */
  async function backpressure(r: Response, action: Backpressure["action"]) {
    const { sec, stated } = retryAfterOf(r);
    const detail = await readDetail(r);
    if (!mounted.current) return;
    dispatch({ type: "SET_ERROR", error: null });
    setBusyNotice({
      detail: detail ?? "other recordings are already being processed",
      retryAfterSec: sec, stated, action,
    });
  }

  /** Re-run the refused call through THIS render's handler (never a stale
   *  closure captured when the 429 landed — the selection may have changed). */
  function retryBusy() {
    const b = busyNotice;
    setBusyNotice(null);
    if (!b) return;
    if (b.action.kind === "scan") void startScan();
    else if (b.action.kind === "speaker") void chooseSpeaker(b.action.sid);
    else void commit();
  }

  // Validate before we accept a file — no upload round-trip for a bad pick.
  async function acceptFile(f: File | undefined | null) {
    if (!f) return;
    const err = await validateUpload(f);
    if (err) { setFile(null); dispatch({ type: "SET_ERROR", error: err }); return; }
    setFile(f); dispatch({ type: "SET_ERROR", error: null });
  }

  async function startScan() {
    if (!file || submitting.current) return; // guard the double-click window
    submitting.current = true;
    setPending("scan"); setBusyNotice(null);
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("mode", ingestMode);
    try {
      const r = await fetch("/api/ingest/scan", { method: "POST", body: fd });
      // The ingest queue is full: the recording is fine and so is the backend.
      if (r.status === 429) { await backpressure(r, { kind: "scan" }); return; }
      if (!r.ok) throw new Error((await readDetail(r)) ?? "scan failed to start");
      const j = await r.json();
      dispatch({ type: "SCAN_STARTED", jobId: j.job_id });
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: e instanceof Error ? e.message : "scan failed" });
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(null);
    }
  }

  async function chooseSpeaker(sid: string) {
    if (submitting.current) return;
    audioRef.current?.pause(); setPlaying(null);
    submitting.current = true;
    setPending(`speaker:${sid}`); setBusyNotice(null);
    try {
      // Verify the backend accepted the speaker before advancing the state
      // machine — an expired/rejected job would otherwise spin the Waveform Lab
      // while the server is still awaiting_speaker (or gone), with no error.
      const r = await fetch(`/api/ingest/${jobId}/speaker`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speaker_id: sid }) });
      // Still on the speaker screen, job untouched server-side — offer the pick
      // again rather than reporting a session that "failed".
      if (r.status === 429) { await backpressure(r, { kind: "speaker", sid }); return; }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        dispatch({ type: "SET_ERROR", error: j?.detail ?? "couldn't select that speaker — the session may have expired" });
        return;
      }
      dispatch({ type: "SPEAKER_CHOSEN" });
    } catch {
      dispatch({ type: "SET_ERROR", error: "couldn't select that speaker — the backend may be offline" });
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(null);
    }
  }

  function playClip(url: string, id: string) {
    if (playing === id) { audioRef.current?.pause(); setPlaying(null); return; }
    audioRef.current?.pause();
    const a = audioRef.current ?? (audioRef.current = new Audio());
    a.src = url; a.onended = () => setPlaying(null);
    setPlaying(id);
    // Reset on rejection (missing/expired preview, autoplay block) instead of
    // leaving the row stuck showing "playing".
    void a.play().catch(() => setPlaying((cur) => (cur === id ? null : cur)));
  }

  async function commit() {
    if (selected.size === 0 || submitting.current) return; // guard the double-click window
    const character = mode === "new" ? charName.trim() : (characters.find((c) => c.character_id === extendCid)?.name ?? "");
    const character_id = mode === "extend" ? extendCid : undefined;
    if (mode === "new" && !character) { dispatch({ type: "SET_ERROR", error: "Name the character" }); return; }
    if (mode === "extend" && !extendCid) { dispatch({ type: "SET_ERROR", error: "Pick a character to extend" }); return; }
    const cid = character_id ?? slug(character);
    submitting.current = true;
    setPending("commit"); setBusyNotice(null);
    dispatch({ type: "COMMIT_STARTED", character, cid, total: selected.size });
    try {
      // async commit: the backend returns immediately; the poller follows
      // per-emotion progress through to 'committed' / 'error'.
      const r = await fetch(`/api/ingest/${jobId}/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ character, emotions: [...selected], character_id, attested: consented, statement: CONSENT_STATEMENT }) });
      // Refused before any cloning started: the ledger is intact, so go back to
      // it with NO error — the amber notice carries the whole truth.
      if (r.status === 429) {
        dispatch({ type: "COMMIT_FAILED", error: null });
        await backpressure(r, { kind: "commit" });
        return;
      }
      // ok-check BEFORE parsing: an unguarded r.json() here once surfaced a raw
      // SyntaxError to the user when the proxy answered with a non-JSON body.
      if (!r.ok) throw new Error((await readDetail(r)) ?? "commit failed");
    } catch (e) {
      dispatch({ type: "COMMIT_FAILED", error: e instanceof Error ? e.message : "commit failed" });
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(null);
    }
  }

  async function cancelCommit() {
    // DELETE tears down the whole job server-side (workdir included), so the
    // review ledger is gone too — the only honest place to land is upload.
    try { await fetch(`/api/ingest/${jobId}`, { method: "DELETE" }); } catch { /* ignore */ }
    startOver();
  }

  function startOver() {
    setFile(null); setBusyNotice(null);
    dispatch({ type: "RESET", kind: "start-over" });
  }

  function scanAnother() {
    setFile(null); setBusyNotice(null);
    dispatch({ type: "RESET", kind: "scan-another" });
  }

  const loaderData: LoaderData = { steps: job?.steps ?? [], partial: job?.partial ?? {}, duration: job?.duration, mode: job?.mode };

  // Which pipeline the copy on this page is describing. Before a scan there is
  // no job, so the user's pill decides — and for `auto` the backend has already
  // told us which way it will resolve. Null only while that is genuinely
  // unknown, and the mode-neutral wording is used then.
  const activeMode: "cloud" | "sovereign" | null =
    job?.mode ?? (ingestMode === "sovereign" ? "sovereign" : modeInfo?.resolved_auto ?? null);
  const sovereign = activeMode === "sovereign";
  const failureNote = segmentFailureNote(job?.partial ?? {});

  return (
    <AppFrame>
      <div className="py-10">
        <Link href="/voices" className="font-jetbrains text-[12px] text-white/45 transition hover:text-white">← characters</Link>
        <Eyebrow>new character</Eyebrow>
        <h1 className="font-instrument mt-3 text-4xl text-white">Build from a recording.</h1>
        {/* Sovereign mode transcribes nothing, diarizes nothing and classifies
            no emotions — this sentence claimed all three unconditionally. */}
        <p className="mt-2 max-w-2xl text-base text-white/70">
          {sovereign
            ? "Drop a recording — we clean it on this machine, find the speech by level, and build the baseline Voice of your Character. Emotions are added afterwards with the guided per-emotion capture."
            : activeMode === "cloud"
            ? "Drop a recording — we transcribe & diarize it, you pick the speaker, we isolate them, detect emotions, and propose a set of emotion Voices to assign into a Character."
            : "Drop a recording — we analyse it, you pick the speaker, and we propose Voices to assign into a Character."}
        </p>

        {error && <ErrorBanner>{error}</ErrorBanner>}
        {/* Backpressure, in the palette the repo reserves for recoverable:
            nothing failed, the queue is full. The retry waits out the backoff
            window, because retrying inside it only adds another rejection. */}
        {busyNotice && (
          <ErrorBanner severity="warning">
            <span className="flex flex-wrap items-center justify-between gap-3">
              <span>
                {busyNotice.detail}.{" "}
                {retryIn > 0
                  ? busyNotice.stated
                    ? `The backend asked for ${retryIn}s before the next attempt.`
                    : `Retry unlocks in ${retryIn}s.`
                  : "You can try again now."}
              </span>
              <button
                onClick={retryBusy}
                disabled={pending !== null || retryIn > 0}
                title={retryIn > 0 ? `waiting ${retryIn}s before retrying` : "try again"}
                className="shrink-0 cursor-pointer rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-amber-100 transition hover:bg-amber-400/20 disabled:cursor-default disabled:opacity-40"
              >
                {pending ? "retrying…" : retryIn > 0 ? `↻ retry in ${retryIn}s` : "↻ retry"}
              </button>
            </span>
          </ErrorBanner>
        )}
        {pollStalled && POLLING_PHASES.has(phase) && (
          <ErrorBanner severity="warning">
            connection to the studio is degraded — retrying. Your job keeps running server-side.
          </ErrorBanner>
        )}

        {/* What THIS job is doing to the recording. Driven by job.mode, so a
            scan that `auto` RESOLVED to sovereign states its limits exactly as
            loudly as one where the pill was pressed — the resolved case used to
            state nothing at all. Shown from the moment analyze finishes (that
            is when the backend has them) through the review ledger. */}
        {job?.mode === "sovereign" && SCAN_PHASES.has(phase) && (
          <div className="mt-4 max-w-3xl space-y-3">
            {(job.limits?.length ?? 0) > 0 && (
              <SovereignLimits limits={job.limits!} heading="sovereign mode · what this scan cannot do" />
            )}
            {job.detection && <DetectionFinding detection={job.detection} note={job.note} />}
          </div>
        )}

        {/* UPLOAD */}
        {phase === "upload" && (
          <div className="mt-8 max-w-2xl">
            <div
              role="button" tabIndex={0} aria-label="Choose or drop an audio recording"
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); void acceptFile(e.dataTransfer.files?.[0]); }}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
              className={`grid cursor-pointer place-items-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition focus:outline-none focus-visible:border-cyan-400/60 focus-visible:bg-cyan-400/5 ${dragging ? "border-cyan-400/60 bg-cyan-400/5" : "border-white/12 hover:border-white/30"}`}
            >
              <input ref={fileRef} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => { void acceptFile(e.target.files?.[0]); }} />
              <div>
                <div className="text-lg text-white">{file ? file.name : "Drop an mp3 / recording, or click to choose"}</div>
                <div className="font-jetbrains mt-1 text-[12px] text-white/55">
                  {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "a minute+ of speech with emotional range works best"}
                </div>
                {/* The caps, printed from the same constants the pre-check
                    uses — a user should learn the ceiling before the upload. */}
                <div className="font-jetbrains mt-1 text-[11px] text-white/35">{LIMITS_HINT}</div>
              </div>
            </div>
            {/* Driven by what this flow will actually DO (extend mode, armed
                with a character) rather than by "a commit happened once" —
                which RESET used to leave behind for a brand-new flow to read. */}
            {mode === "extend" && extendCid && (
              <p className="font-jetbrains mt-3 text-[12px] text-cyan-300/80">Extending an existing character with more emotions.</p>
            )}

            {/* privacy mode */}
            <div className="glass-panel mt-4 rounded-2xl p-4">
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setIngestMode("auto")} aria-pressed={ingestMode === "auto"}
                  className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] transition ${ingestMode === "auto" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"}`}>
                  Cloud quality
                </button>
                <button onClick={() => setIngestMode("sovereign")} aria-pressed={ingestMode === "sovereign"}
                  className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] transition ${ingestMode === "sovereign" ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-white/12 text-white/60 hover:text-white"}`}>
                  🔒 Sovereign — audio never leaves this machine
                </button>
              </div>
              {/* Everything below is the BACKEND's description of the modes.
                  This panel used to re-type SOVEREIGN_LIMITS by hand, so the
                  two could drift with nothing to catch it, and `auto` never
                  said which mode it would actually resolve to. */}
              <div className="mt-3 space-y-2">
                {modeInfoFailed && (
                  <ErrorBanner severity="warning">
                    couldn&apos;t load what each mode does from the backend — the limits of
                    whichever mode runs are stated again once the scan starts.
                  </ErrorBanner>
                )}
                {!modeInfo && !modeInfoFailed && (
                  <p className="font-jetbrains text-[11px] text-white/40">loading what each mode does…</p>
                )}
                {ingestMode === "sovereign" ? (
                  modeInfo && (
                    <p className="font-jetbrains text-[11px] leading-relaxed text-white/50">
                      {modeInfo.sovereign.note}
                    </p>
                  )
                ) : (
                  <p className="font-jetbrains text-[11px] leading-relaxed text-white/50">
                    Uses ElevenLabs (diarize + isolate) and Gemini (emotion labels) when the
                    backend has keys, and the local sovereign pipeline when it doesn&apos;t.
                    {modeInfo?.resolved_auto === "sovereign" &&
                      " This backend has no cloud keys configured, so auto will run the local pipeline — with the limits below."}
                    {modeInfo?.resolved_auto === "cloud" &&
                      " This backend has cloud keys, so auto will run the cloud pipeline."}
                  </p>
                )}
                {modeInfo && (ingestMode === "sovereign" || modeInfo.resolved_auto === "sovereign") && (
                  <SovereignLimits limits={modeInfo.sovereign.limits} />
                )}
              </div>
            </div>

            {/* The kickoff uploads the whole file and is allowed 120s by the
                proxy — without a pending state the page looked inert. */}
            <Button onClick={startScan} disabled={!file || pending !== null} className="mt-5 cursor-pointer">
              {pending === "scan" ? "Uploading & starting…" : "Scan recording →"}
            </Button>
          </div>
        )}

        {/* PROCESSING — Waveform Lab won the loader round */}
        {phase === "processing" && (
          <div className="mt-10 max-w-3xl">
            {job?.mode === "sovereign" && (
              <p className="font-jetbrains mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/5 px-3 py-1 text-[11px] text-emerald-200">
                🔒 sovereign mode — processing locally, audio stays on this machine
              </p>
            )}
            <WaveformLab data={loaderData} />
          </div>
        )}

        {/* SPEAKER PICK */}
        {phase === "speaker" && job?.speakers && (
          <div className="mt-8 max-w-3xl">
            <h2 className="font-instrument text-2xl text-white">
              {job.mode === "sovereign" ? "This is what will be cloned." : "Which voice is your character?"}
            </h2>
            {/* "N speakers detected" is a diarization result. Sovereign mode has
                no diarizer — its single entry is an assumption, not a finding,
                and it was also printing "1 speakers". */}
            <p className="mt-1 text-sm text-white/60">
              {job.mode === "sovereign"
                ? "Sovereign mode cannot tell speakers apart, so everything audible is treated as one speaker. Play the sample to hear what that is, then continue."
                : `${job.speakers.length} speaker${job.speakers.length === 1 ? "" : "s"} detected. Play a sample, then pick the one to build from.`}
            </p>
            <div className="mt-5 space-y-2">
              {job.speakers.map((s, i) => (
                <div key={s.id} className="glass-panel flex items-center gap-3 rounded-xl px-4 py-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-slate-950" style={{ background: `hsl(${(i * 67) % 360} 85% 65%)` }}>{i + 1}</span>
                  <button onClick={() => playClip(`/api/ingest/${jobId}/speaker-preview/${s.id}`, s.id)} aria-label="Play sample"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110">
                    {playing === s.id ? "⏸" : "▶"}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="font-jetbrains text-[12px] text-white/80">{s.id} · <span className="text-white">{s.seconds}s</span> · {s.utterances} utterances</div>
                    {/* Quotation marks + italics mean "this is what they said".
                        In sovereign mode nothing is transcribed, so sample_text
                        is a finding about the recording and is set as one. */}
                    {job.mode === "sovereign" ? (
                      <div className="text-[12px] leading-snug text-white/50">{s.sample_text}</div>
                    ) : (
                      <div className="line-clamp-1 text-sm italic text-white/50">“{s.sample_text}”</div>
                    )}
                  </div>
                  <Button onClick={() => chooseSpeaker(s.id)} disabled={pending !== null}
                    className="shrink-0 cursor-pointer px-4 py-2 text-[13px]">
                    {pending === `speaker:${s.id}` ? "selecting…" : "Use this →"}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* REVIEW — ledger */}
        {phase === "review" && result && (
          <div className="mt-8">
            <div className="font-jetbrains flex flex-wrap gap-4 text-[12px] text-white/60">
              <span>{result.duration}s audio</span>
              <span>
                {result.mode === "sovereign"
                  ? "single speaker assumed (no local diarization)"
                  : `${result.speakers.length} speaker${result.speakers.length === 1 ? "" : "s"}`}
                {" · "}target <span className="text-white">{result.target}</span>
              </span>
              <span>{result.utterances} utterances</span>
            </div>
            {/* What the pipeline DOES with a failed segment: nothing. The
                `usable` filter drops it, so it reaches no stem at all — the
                opposite of the "fell back to the baseline stem" this said. */}
            {failureNote && <ErrorBanner severity="warning">{failureNote}</ErrorBanner>}

            <div className="mt-6 flex items-end justify-between">
              <div>
                <h2 className="font-instrument text-2xl text-white">Proposed voices</h2>
                <p className="mt-1 text-sm text-white/60">
                  Keep or descope each emotion. “Short” stems hold under{" "}
                  {result.min_stem}s of audio, the minimum this backend clones from.
                </p>
              </div>
              <span className="font-jetbrains text-[12px] text-white/60">{selected.size} selected</span>
            </div>

            <div className="glass-panel mt-4 overflow-x-auto rounded-xl">
              <table className="w-full min-w-[680px] border-collapse text-sm">
                <thead className="border-b border-white/8">
                  <tr className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
                    <th className="w-12 px-3 py-2" />
                    <th className="px-3 py-2 text-left font-normal">emotion</th>
                    <th className="px-3 py-2 text-left font-normal">length</th>
                    <th className="px-3 py-2 text-left font-normal">segments</th>
                    <th className="px-3 py-2 text-left font-normal">vocal cue</th>
                    <th className="w-24 px-3 py-2" />
                    <th className="w-28 px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {result.stems.map((st) => {
                    const on = selected.has(st.emotion);
                    const m = emotionMeta(st.emotion);
                    return (
                      <tr key={st.emotion} className={`border-b border-white/5 transition hover:bg-white/[0.03] ${on ? "" : "opacity-55"}`}>
                        <td className="px-3 py-2">
                          <span className="grid h-9 w-9 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
                            <EmotionArt emotion={st.emotion} size={30} dim={!on} />
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2 text-sm font-medium text-white">
                            <span className="h-2 w-2 rounded-full" style={{ background: `hsl(${m.hue} 85% 62%)` }} />{m.label}
                            {!st.eligible && <span className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">short</span>}
                            {st.note && <span className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">mixed</span>}
                          </span>
                          {st.note && <span className="mt-1 block max-w-[26rem] text-[11px] leading-snug text-amber-200/70">{st.note}</span>}
                        </td>
                        <td className="font-jetbrains px-3 py-2 text-[12px] text-white/70">{st.seconds}s</td>
                        <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{st.segments}</td>
                        <td className="px-3 py-2 text-[12px] italic text-white/50">{st.cues[0] ? `“${st.cues[0]}”` : "—"}</td>
                        <td className="px-3 py-2">
                          <button onClick={() => playClip(`/api/ingest/${jobId}/preview/${st.emotion}`, `stem-${st.emotion}`)}
                            aria-label={`${playing === `stem-${st.emotion}` ? "Pause" : "Play"} ${m.label} stem`}
                            className="grid h-8 w-8 place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110">
                            {playing === `stem-${st.emotion}` ? "⏸" : "▶"}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button onClick={() => dispatch({ type: "TOGGLE_EMOTION", emotion: st.emotion })} aria-pressed={on}
                            className={`font-jetbrains rounded-lg border px-2.5 py-1 text-[11px] transition ${on ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/55 hover:text-white"}`}>
                            {on ? "✓ keep" : "descope"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="glass-panel mt-6 max-w-2xl rounded-2xl p-5">
              <div className="flex gap-2">
                <button onClick={() => dispatch({ type: "SET_MODE", mode: "new" })} className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] ${mode === "new" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60"}`}>New character</button>
                <button onClick={() => dispatch({ type: "SET_MODE", mode: "extend" })} disabled={characters.length === 0} className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] disabled:opacity-40 ${mode === "extend" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60"}`}>Extend existing</button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {mode === "new" ? (
                  <input value={charName} onChange={(e) => dispatch({ type: "SET_CHAR_NAME", name: e.target.value })} placeholder="Character name"
                    className="font-hanken w-56 rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
                ) : (
                  <select value={extendCid} onChange={(e) => dispatch({ type: "SET_EXTEND_CID", cid: e.target.value })}
                    className="font-jetbrains rounded-xl border border-white/12 bg-[#0d1017] px-3 py-2.5 text-[13px] text-white/85 focus:outline-none">
                    <option value="">choose character…</option>
                    {characters.map((c) => <option key={c.character_id} value={c.character_id}>{c.name}</option>)}
                  </select>
                )}
                <Button onClick={commit} disabled={selected.size === 0 || !consented || pending !== null} className="ml-auto cursor-pointer">
                  {pending === "commit"
                    ? "Starting…"
                    : `${mode === "new" ? "Create character" : "Add to character"} (${selected.size})`}
                </Button>
              </div>
              <label className="mt-4 flex cursor-pointer items-start gap-2 text-[13px] text-white/70">
                <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)}
                  className="mt-0.5 accent-cyan-300" />
                <span>
                  I own this voice or have the speaker&apos;s explicit consent to clone it.{" "}
                  <span className="font-jetbrains text-[11px] text-white/45">
                    (attestation stored with the voices — Voice Vault)
                  </span>
                </span>
              </label>
            </div>
          </div>
        )}

        {/* COMMITTING — real per-emotion progress from the async commit */}
        {phase === "committing" && (() => {
          const total = job?.partial?.emotions_total ?? selected.size;
          const done = job?.partial?.emotions_done ?? 0;
          const current = job?.partial?.current ?? null;
          const pct = total ? Math.round((done / total) * 100) : 0;
          return (
            <div className="mt-16 text-center">
              <div className="font-jetbrains text-[12px] uppercase tracking-widest text-cyan-300">
                cloning voices · {done}/{total}
              </div>
              <p className="mt-2 text-sm text-white/60">
                {current ? <>Cloning <span className="text-white">{emotionMeta(current).label}</span> on the CPU engine…</> : "Cloning on the CPU engine…"}
              </p>
              <div className="mx-auto mt-5 h-1.5 w-64 overflow-hidden rounded-full bg-white/10"
                role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
                aria-label={`Cloning voices, ${done} of ${total} done`}>
                <div className="h-full rounded-full bg-cyan-300 transition-all duration-500" style={{ width: `${pct}%` }} />
              </div>
              <button onClick={cancelCommit}
                className="font-jetbrains mt-6 cursor-pointer rounded-full border border-white/15 px-5 py-2 text-[13px] text-white/70 transition hover:bg-white/5">
                Cancel
              </button>
            </div>
          );
        })()}

        {/* EXPIRED — the job aged out (or was cancelled); poller stopped */}
        {phase === "expired" && (
          <div className="mt-10 max-w-2xl">
            <div className="glass-panel rounded-2xl p-6">
              <div className="font-jetbrains text-[11px] uppercase tracking-widest text-amber-300">session expired</div>
              <h2 className="font-instrument mt-2 text-3xl text-white">This ingest session ended.</h2>
              <p className="mt-2 text-sm text-white/60">
                Scan sessions are held for a limited time and then cleaned up. Nothing was saved — start over with your recording.
              </p>
              <button onClick={startOver}
                className="mt-6 cursor-pointer rounded-full bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110">
                Start over
              </button>
            </div>
          </div>
        )}

        {/* COMPLETE */}
        {phase === "complete" && (
          <div className="mt-10 max-w-2xl">
            <div className="glass-panel rounded-2xl p-6">
              <div className="font-jetbrains text-[11px] uppercase tracking-widest text-emerald-300">character ready</div>
              <h2 className="font-instrument mt-2 text-3xl text-white">{created.length} voices cloned.</h2>
              {vaultWarn && (
                <p className="font-jetbrains mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/85">
                  Voices cloned, but the consent receipt couldn’t be saved to your vault. Reload “My Voices” — if they’re missing, re-open the character to re-record ownership.
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {created.map((c) => {
                  const m = emotionMeta(c.emotion);
                  return (
                    <span key={c.voice_id} className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] text-white/80">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${m.hue} 80% 62%)` }} />{m.label}
                    </span>
                  );
                })}
              </div>
              {/* Coverage Coach — the recording produced an incomplete rack;
                  give every remaining slot a direct path to done. Stems that
                  were detected but too short to clone are called out. */}
              {committedCid && (() => {
                const done = new Set(created.map((c) => c.emotion));
                const missing = EMOTION_IDS.filter((e) => !done.has(e));
                if (missing.length === 0) return null;
                const shortStems = new Set(
                  (result?.stems ?? []).filter((s) => !s.eligible).map((s) => s.emotion),
                );
                return (
                  <div className="mt-6 rounded-2xl border border-amber-400/15 bg-amber-400/[0.04] p-4">
                    <div className="font-jetbrains text-[11px] uppercase tracking-widest text-amber-200/80">
                      coverage coach · {done.size}/{EMOTION_IDS.length} recorded
                    </div>
                    <p className="mt-1 text-sm text-white/65">
                      Finish the rack with a guided 30-second read per emotion — no new recording to hunt for:
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {missing.map((e) => (
                        <Link
                          key={e}
                          href={`/voices/${committedCid}?record=${e}`}
                          className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-black/30 px-2.5 py-1 text-[11px] text-amber-200/90 transition hover:border-amber-300/50 hover:text-amber-100"
                        >
                          ● {emotionMeta(e).label}
                          {shortStems.has(e) && <span className="text-white/45">(detected, too short)</span>}
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div className="mt-6 flex flex-wrap gap-3">
                {committedCid && <Link href={`/voices/${committedCid}`} className="rounded-full bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110">Open character →</Link>}
                <button onClick={scanAnother} className="font-jetbrains cursor-pointer rounded-full border border-white/15 px-5 py-2.5 text-sm text-white/85 transition hover:bg-white/5">Scan another recording (extend palette)</button>
                <Link href="/voices" className="font-jetbrains rounded-full px-5 py-2.5 text-sm text-white/60 transition hover:text-white">Back to roster</Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppFrame>
  );
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";
}

// ── client-side upload pre-check ──────────────────────────────────────────────
// The rules and the numbers live in _state/uploadLimits.ts — ONE mirror of the
// backend gate. Only the browser-side probing lives here.

/** Can this browser decode the type at all? Decides what an unknown duration
 *  MEANS: a broken file (it can, and still got nothing) or simply a container
 *  the browser does not speak while ffprobe does (.amr, .wma, .mkv …). */
function browserCanDecode(file: File): boolean {
  if (!file.type) return false;
  try {
    return document.createElement("audio").canPlayType(file.type) !== "";
  } catch {
    return false; // no verdict available → the server's probe is the only one
  }
}

// Probe duration by loading metadata into a throwaway <audio> element.
// Resolves null when the browser can't determine it (backend re-probes).
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("audio");
    a.preload = "metadata";
    let settled = false;
    const finish = (v: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(t); URL.revokeObjectURL(url); a.removeAttribute("src"); resolve(v);
    };
    // Some containers the backend accepts (mkv/amr/…) may never fire an event
    // in the browser — never block the picker: fall back to "unknown" (null),
    // and let the server re-probe.
    const t = setTimeout(() => finish(null), 4000);
    a.onloadedmetadata = () => finish(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => finish(null);
    a.src = url;
  });
}

async function validateUpload(file: File): Promise<string | null> {
  const bytes = checkBytes(file);
  if (bytes) return bytes;
  // Floor AND ceiling, and fail-closed on a length the browser should have been
  // able to read: a 20-minute recording used to upload 50 MB to earn a 400.
  return checkDuration(await probeDuration(file), browserCanDecode(file));
}
