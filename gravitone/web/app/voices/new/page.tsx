"use client";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Fragment, useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import AppFrame from "@/components/ui/AppFrame";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { useTransport } from "@/components/ui/useTransport";
import EmotionArt from "@/components/ui/EmotionArt";
import { apiJson, readDetail } from "@/lib/apiFetch";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import { useAuth } from "@/lib/useAuth";
import { useMounted } from "@/lib/useMounted";
import { characterSlug } from "@/lib/slugs";
import { loadRoster } from "@/app/voices/_data/characters";
import { recordVoiceOwnership } from "@/lib/voiceVault";
import { CONSENT_STATEMENT, EXTERNAL_CONSENT_STATEMENT } from "@/lib/consent";
import WaveformLab from "./_loaders/WaveformLab";
import { DetectionFinding, SovereignLimits, segmentFailureNote, type LoaderData } from "./_loaders/shared";
// The two review drill-downs are ~600 lines (plus framer-motion, through
// _loaders/shared) reachable only from an EXPANDED ledger row — and they were
// statically imported into a first paint that is a dropzone. Neither needs SSR:
// this is a client page, and both mount from a click.
const SegmentBoard = dynamic(() => import("./_review/SegmentBoard"), {
  ssr: false, loading: () => <PanelLoading label="opening the casting board…" />,
});
const AuditionPanel = dynamic(() => import("./_review/AuditionPanel"), {
  ssr: false, loading: () => <PanelLoading label="opening the audition room…" />,
});

/** The ledger's own visual language while a drill-down arrives: the same glass
 *  panel it will become, saying what it is waiting for. */
function PanelLoading({ label }: { label: string }) {
  return (
    <div className="glass-panel rounded-2xl px-4 py-6">
      <span className="font-jetbrains text-[11px] text-white/40">{label}</span>
    </div>
  );
}
import {
  reducer, initialState, POLLING_PHASES, WATCH_PHASES,
  type CastResult, type Character, type Job, type ModeInfo, type Stem,
} from "./_state/machine";
import { CANCEL_UNFINISHED, assetRefusal, cancelIngest } from "./_state/failures";
import { candidates, commitRecipes, recipeById } from "./_state/audition";
import { corpusNotice } from "./_state/corpus";
import { identityMeasured, isEdited, stemIdentity } from "./_state/casting";
import { useCasting } from "./_state/useCasting";
import {
  ACCEPT_ATTR, LIMITS_HINT, checkBytes, checkDuration,
} from "./_state/uploadLimits";
import { useIngestJob } from "./_state/useIngestJob";
import { takeKey, useAudition } from "./_state/useAudition";
import { useLinkProbe } from "./_state/useLinkProbe";

// Phases where a scanned recording is on screen and the mode that produced it
// is still load-bearing for what the user is reading.
const SCAN_PHASES: ReadonlySet<string> = new Set(["processing", "speaker", "review"]);

// Which mutating call is in flight. `submitting` (a ref) still owns the atomic
// double-submit gate; this is the same fact made VISIBLE — a ref cannot put a
// button into a pending state, and the scan kickoff is allowed 120 seconds.
type Pending = null | "scan" | "commit" | `speaker:${string}`;

// Which door the recording comes through. The link tab is a second WAY IN and
// nothing more: it produces the same job id, so every screen after this one is
// untouched by it.
type SourceTab = "file" | "link";

// Backpressure, not failure: /scan, /speaker and /commit all pass through the
// ingest admission gate (service/ingest_api.py::_admit), which answers 429 when
// too many recordings are already being processed. Same shape the playground
// uses for the engine's 429 (PlaygroundConsole busyNotice + Retry-After
// countdown) — amber, with a retry that waits out the backoff window.
type Backpressure = {
  detail: string;
  retryAfterSec: number;
  stated: boolean;   // did the response actually carry a Retry-After?
  action: { kind: "scan" } | { kind: "link" } | { kind: "speaker"; sid: string } | { kind: "commit" };
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
    mode, charName, extendCid, committedCid, created, auditions,
    assignments, dirty } = state;

  // Ephemeral input/UI state — not part of the flow's state graph.
  const [consented, setConsented] = useState(false); // Voice Vault attestation
  // The retention opt-in, and it lives at the CONSENT moment rather than at
  // upload on purpose. The service takes `corpus` at both points (scan's Form
  // field and the commit body, the commit winning — ingest_api.py:1038/1583);
  // asking at upload would demand a retention decision before the user has seen
  // what the recording even contains, and the commit would override it anyway.
  // So the scan sends nothing (service default: off) and every commit sends an
  // EXPLICIT true/false — the job's outcome then names what this checkbox said.
  const [keepCorpus, setKeepCorpus] = useState(false);
  // Where THIS job's audio came from, as the backend recorded it — never from
  // which tab the user happened to click, which a reload would forget.
  const externalSource = job?.source?.kind === "url";
  const consentStatement = externalSource ? EXTERNAL_CONSENT_STATEMENT : CONSENT_STATEMENT;
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  // The link door. `linkTab` is which input is on screen; `link` is the pasted
  // URL. Both are ephemeral input state — the moment a scan starts, the flow's
  // state graph knows only that a job exists, exactly as with a file.
  const [srcTab, setSrcTab] = useState<SourceTab>("file");
  const [link, setLink] = useState("");
  // The paste-time verdict — metadata only, no media moves. It is what makes
  // "47-minute video, we'll clone the first 15 minutes" a sentence the user
  // reads BEFORE the download rather than a surprise after it.
  const linkProbe = useLinkProbe(link, phase === "upload" && srcTab === "link");
  const linkUsable = linkProbe.status === "done" && linkProbe.verdict.ok;
  // auto = cloud quality when the backend has API keys, else local.
  // sovereign = force local-only: the recording never leaves the machine.
  const [ingestMode, setIngestMode] = useState<"auto" | "sovereign">("auto");
  const [characters, setCharacters] = useState<Character[]>([]);
  // An empty `characters` means "you have nothing to extend"; this means "we
  // could not find out". The two must not render the same.
  const [rosterFailed, setRosterFailed] = useState(false);
  // What the BACKEND says each mode does — including which mode `auto` resolves
  // to on this box. The panel below states sovereign's limits from this, never
  // from a copy of the constant kept over here.
  const [modeInfo, setModeInfo] = useState<ModeInfo | null>(null);
  const [modeInfoFailed, setModeInfoFailed] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false); // re-entrancy guard for scan/speaker/commit
  const [pending, setPending] = useState<Pending>(null); // the same fact, visible
  const mounted = useMounted();
  // The one clip this screen is playing, and the transport that plays it.
  // `playing` is DERIVED from the transport rather than set on click: a play()
  // the browser refuses must never leave a row saying "playing".
  const [clip, setClip] = useState<{ url: string; id: string } | null>(null);
  const transport = useTransport({ src: clip?.url });
  const playing = transport.playing ? clip?.id ?? null : null;
  // The service's own sentence about a clip that would not play.
  const [clipRefusal, setClipRefusal] = useState<string | null>(null);
  // A new clip starts when the element has it — one commit later, so the <audio>
  // is already holding the src. Deliberately not useTransport's `autoPlay`:
  // that starts with `asked: false` (an autoplay a browser refuses is policy,
  // not a broken take), and every one of these IS a click, so a refusal here is
  // a real failure and must be reported as one.
  useEffect(() => { if (clip) transport.play(); }, [clip]);   // eslint-disable-line react-hooks/exhaustive-deps
  // …and when it is, ask the service why. The element is told nothing about a
  // 404 body; the proxy still has the sentence.
  useEffect(() => {
    if (!transport.failed || !clip) return;
    void assetRefusal(clip.url).then((detail) => {
      if (detail && mounted.current) setClipRefusal(detail);
    });
  }, [transport.failed, clip, mounted]);
  // A DELETE that did NOT tear the job down. Load-bearing: while this is set,
  // the flow has not been reset, because resetting would tell the user the
  // session is gone while the backend may still be cloning into their roster.
  const [cancelFailed, setCancelFailed] = useState<string | null>(null);
  const cancelling = useRef(false); // atomic gate — Cancel is double-clickable
  // Which ledger row has its Audition Room open. Exactly one at a time, and null
  // is the normal state: the fast path is still keep/descope then commit.
  const [auditionFor, setAuditionFor] = useState<string | null>(null);
  const { takes, request: requestTake } = useAudition(jobId);
  // Which ledger row has its Casting Board open. Independent of the Audition
  // Room: one answers "what is in this stem", the other "what does it sound
  // like as a voice", and a user can want both about the same emotion.
  const [boardFor, setBoardFor] = useState<string | null>(null);
  const casting = useCasting(
    jobId,
    useCallback((cast: CastResult) => dispatch({ type: "CAST_SYNCED", cast }), []),
  );

  /** Cast segments into stems: the checkbox answers immediately, the re-splice
   *  behind it is debounced, and the LENGTH only ever moves when the service
   *  answers with what it measured. */
  function castSegments(next: Record<string, number[]>) {
    dispatch({ type: "CAST_SEGMENTS", assignments: next });
    casting.cast(next);
  }

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
  //
  // This goes through loadRoster (the shared data layer) like every other
  // roster read. It used to be a third, private apiJson("/api/characters")
  // whose .catch set [] — so a failed read was rendered as "you have no
  // characters to extend", and the module comment claiming the duplicates were
  // consolidated was false. A failure now SAYS so, next to the control it
  // disables.
  const atUpload = phase === "upload";
  const atComplete = phase === "complete";
  const [rosterLoaded, setRosterLoaded] = useState(false);
  useEffect(() => {
    if (!atUpload && !atComplete) return;
    const ctrl = new AbortController();
    void loadRoster(ctrl.signal)
      .then((cs) => {
        if (!mounted.current) return;
        setCharacters(cs.filter((c) => c.category === "cloned"));
        setRosterFailed(false);
        setRosterLoaded(true);
      })
      .catch(() => {
        // An abort is this effect being replaced, not a failure.
        if (ctrl.signal.aborted || !mounted.current) return;
        setRosterFailed(true);
      });
    return () => ctrl.abort();
  }, [atUpload, atComplete, mounted]);

  // ── the clone loop's inbound leg ────────────────────────────────────────────
  // /voices/new?extend={character_id} — arrived from a character's own page.
  // The param only ARMS the flow; it is applied once the roster has actually
  // answered, because "extend" is only real for a character that exists and is
  // cloneable. A param naming something the roster does not have is SAID (the
  // flow silently falling back to "New character" would create a second
  // character with the same name), and a roster that could not be read says
  // that instead — the two are different facts and never share a message.
  const [fromCid, setFromCid] = useState<string | null>(null);
  const [fromUnknown, setFromUnknown] = useState<string | null>(null);
  const preselected = useRef(false);
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("extend");
    if (want) setFromCid(want);
  }, []);
  useEffect(() => {
    if (preselected.current || !fromCid || !rosterLoaded) return;
    preselected.current = true;
    if (characters.some((c) => c.character_id === fromCid)) {
      dispatch({ type: "SET_MODE", mode: "extend" });
      dispatch({ type: "SET_EXTEND_CID", cid: fromCid });
    } else {
      setFromUnknown(fromCid);
    }
  }, [fromCid, rosterLoaded, characters]);
  // The character this flow will return to, by name — only once it is genuinely
  // armed, so the completion screen never promises a destination it invented.
  const returningTo = fromCid && !fromUnknown
    ? characters.find((c) => c.character_id === fromCid)?.name ?? null
    : null;

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

  // ONE poller for the analyze leg, the commit leg AND the review watch — the
  // last of which exists because a job dies of idleness while it is being
  // reviewed (see WATCH_PHASES) and the screen used to keep looking alive.
  const [pollStalled, setPollStalled] = useState(false);
  const watching = WATCH_PHASES.has(phase);
  useIngestJob({
    jobId,
    enabled: POLLING_PHASES.has(phase) || watching,
    watch: watching,
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
    else if (b.action.kind === "link") void startLinkScan();
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

  /** The link door. Same dispatch, same job, same everything downstream — the
   *  ONLY difference from `startScan` is that the bytes are fetched by the
   *  backend instead of uploaded by the browser.
   *
   *  Failure here is loud on purpose: extraction is the brittle part of this
   *  feature (a private video, an age gate, a pinned yt-dlp that has aged out),
   *  and the backend answers those by name. The banner prints the backend's own
   *  sentence — each of which ends in the file-drop fallback — rather than a
   *  spinner that never resolves. */
  async function startLinkScan() {
    if (!link.trim() || submitting.current) return; // same double-click gate
    submitting.current = true;
    setPending("scan"); setBusyNotice(null);
    try {
      const r = await fetch("/api/ingest/scan-url", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: link.trim(), mode: ingestMode }),
      });
      // Backpressure, not a bad link: the queue is full and the URL is fine.
      if (r.status === 429) { await backpressure(r, { kind: "link" }); return; }
      if (!r.ok) throw new Error((await readDetail(r)) ?? "couldn't start from that link");
      const j = await r.json();
      dispatch({ type: "SCAN_STARTED", jobId: j.job_id });
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: e instanceof Error ? e.message : "couldn't start from that link" });
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(null);
    }
  }

  async function chooseSpeaker(sid: string) {
    if (submitting.current) return;
    transport.pause();
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

  /** Play one clip on the review screen's ONE transport.
   *
   *  It used to be a private `new Audio()` in a ref, which is exactly the debt
   *  <AuditionPanel> had a comment about: the Casting Board's segments play
   *  through the shared <TakePlayer>, this played through something the shared
   *  transport had never heard of, and the two were not mutually exclusive — a
   *  stem and a segment could talk over each other mid-review. Now everything
   *  on this screen is one transport, registered with the AudioBus (so the
   *  signal channels move with the stem the user is listening to) and exclusive
   *  with every other player in the app. */
  function playClip(url: string, id: string) {
    setClipRefusal(null);
    if (clip?.id === id && transport.playing) { transport.pause(); return; }
    // Same clip again: the element already holds it, so there is nothing to
    // load — replaying is the transport's own job.
    if (clip?.url === url) { transport.play(); return; }
    setClip({ url, id });
  }

  /** Hear an emotion AS A VOICE — the clone of its chosen (or default) take,
   *  speaking the studio's line. One click, no drill-down: the audition is
   *  optional, but hearing one is not something a user should have to opt into
   *  a sub-view for. */
  async function hearAsVoice(st: Stem) {
    const rid = auditions[st.emotion] ?? "full";
    const id = `voice-${st.emotion}`;
    const known = takes[takeKey(st.emotion, rid, "")];
    if (known?.url) { playClip(known.url, id); return; }
    const url = await requestTake(st.emotion, rid, "");
    if (url) playClip(url, id);
  }

  async function commit() {
    if (selected.size === 0 || submitting.current) return; // guard the double-click window
    const character = mode === "new" ? charName.trim() : (characters.find((c) => c.character_id === extendCid)?.name ?? "");
    const character_id = mode === "extend" ? extendCid : undefined;
    if (mode === "new" && !character) { dispatch({ type: "SET_ERROR", error: "Name the character" }); return; }
    if (mode === "extend" && !extendCid) { dispatch({ type: "SET_ERROR", error: "Pick a character to extend" }); return; }
    const cid = character_id ?? characterSlug(character);
    submitting.current = true;
    setPending("commit"); setBusyNotice(null);
    dispatch({ type: "COMMIT_STARTED", character, cid, total: selected.size });
    try {
      // async commit: the backend returns immediately; the poller follows
      // per-emotion progress through to 'committed' / 'error'.
      // `recipes` is present ONLY when an audition actually changed something —
      // the fast path sends exactly the body it always sent.
      const recipes = commitRecipes(auditions, selected, result?.stems ?? []);
      const r = await fetch(`/api/ingest/${jobId}/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ character, emotions: [...selected], character_id, attested: consented, statement: consentStatement, corpus: keepCorpus, ...(recipes ? { recipes } : {}) }) });
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
    //
    // But ONLY if the DELETE actually happened. This used to swallow its
    // failure and start over unconditionally: the user was shown a fresh
    // dropzone, told nothing, while the backend kept cloning voices into their
    // roster. A failed cancel now stays on this screen and says what is still
    // true (the poller keeps running, so a commit that finishes anyway still
    // lands on the complete screen).
    if (!jobId || cancelling.current) return;
    cancelling.current = true;
    setCancelFailed(null);
    try {
      const outcome = await cancelIngest(jobId);
      if (!mounted.current) return;
      if (!outcome.ok) { setCancelFailed(outcome.detail); return; }
      startOver();
    } finally {
      cancelling.current = false;
    }
  }

  function startOver() {
    setFile(null); setBusyNotice(null); setKeepCorpus(false);
    setCancelFailed(null); setClipRefusal(null);
    dispatch({ type: "RESET", kind: "start-over" });
  }

  function scanAnother() {
    // The retention opt-in is re-taken per recording, never inherited: it is a
    // decision about THIS audio, and carrying it forward would keep a second
    // recording on the box on the strength of a tick about the first.
    setFile(null); setBusyNotice(null); setKeepCorpus(false);
    setCancelFailed(null); setClipRefusal(null);
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
        {/* The review screen's ONE audio element — stems, speaker samples and
            auditions all play through it. Never shown (this page draws its own
            play buttons per row), but it is a real element in the tree so the
            AudioBus can tap it and the shared transport can own it. */}
        <audio {...transport.audioProps} className="hidden" />
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
        {pollStalled && (POLLING_PHASES.has(phase) || watching) && (
          <ErrorBanner severity="warning">
            {watching
              // Nothing is running to keep running: what is at stake here is
              // that we cannot tell whether the session is still there, and a
              // commit against a session that has gone will fail.
              ? "connection to the studio is degraded — retrying. Until it is back we can't tell whether this scan session is still open."
              : "connection to the studio is degraded — retrying. Your job keeps running server-side."}
          </ErrorBanner>
        )}
        {/* A clip that would not play, in the service's own words. The <audio>
            element never sees the refusal body, so the sentence is fetched from
            the proxy after the failure — see _state/failures#assetRefusal. */}
        {clipRefusal && (
          <ErrorBanner severity="warning">
            that clip wouldn&apos;t play — {clipRefusal}
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
            {/* Two doors into the same flow. A tab rather than a second page:
                whichever one is used, what comes back is a job id and every
                screen after this is identical. */}
            <div role="tablist" aria-label="Where the recording comes from"
              className="mb-4 flex gap-2">
              {([["file", "Drop a file"], ["link", "Paste a link"]] as const).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={srcTab === id}
                  onClick={() => { setSrcTab(id); dispatch({ type: "SET_ERROR", error: null }); }}
                  className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] transition ${srcTab === id ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"}`}>
                  {label}
                </button>
              ))}
            </div>

            {srcTab === "link" && (
              <div className="glass-panel rounded-2xl p-4">
                <label htmlFor="ingest-link" className="text-sm text-white">
                  Paste a YouTube link
                </label>
                <input id="ingest-link" type="url" inputMode="url" value={link} spellCheck={false}
                  placeholder="https://www.youtube.com/watch?v=…"
                  onChange={(e) => { setLink(e.target.value); dispatch({ type: "SET_ERROR", error: null }); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && linkUsable && pending === null) { e.preventDefault(); void startLinkScan(); } }}
                  className="font-jetbrains mt-2 w-full rounded-xl border border-white/12 bg-black/30 px-3 py-2 text-[13px] text-white outline-none transition placeholder:text-white/25 focus:border-cyan-400/50" />

                {/* THE VERDICT, before any media moves. Four states and not one
                    of them is a spinner that ends nowhere:
                      checking — we are asking, and say so
                      done/ok  — what fits, and what will be cut if anything
                      done/!ok — a link we read and refused, with the reason
                      failed   — a link we could not read, with the fallback */}
                {linkProbe.status === "checking" && (
                  <p className="font-jetbrains mt-3 text-[12px] text-white/50" aria-live="polite">
                    checking that link…
                  </p>
                )}
                {linkProbe.status === "done" && linkProbe.verdict.ok && (
                  <div className={`mt-3 rounded-xl border px-3 py-2 ${linkProbe.verdict.trimmed ? "border-amber-400/30 bg-amber-400/5" : "border-emerald-400/25 bg-emerald-400/5"}`}
                    aria-live="polite">
                    <div className="text-[13px] text-white">{linkProbe.verdict.title}</div>
                    <div className={`font-jetbrains mt-0.5 text-[12px] ${linkProbe.verdict.trimmed ? "text-amber-200" : "text-emerald-200"}`}>
                      {linkProbe.verdict.message}
                    </div>
                  </div>
                )}
                {linkProbe.status === "done" && !linkProbe.verdict.ok && (
                  <div className="mt-3">
                    <ErrorBanner>{linkProbe.verdict.message}</ErrorBanner>
                  </div>
                )}
                {linkProbe.status === "failed" && (
                  <div className="mt-3">
                    <ErrorBanner>{linkProbe.detail}</ErrorBanner>
                  </div>
                )}

                {/* Said before the paste, not after the failure: this box
                    fetches from YouTube only, and what it fetches is subject to
                    the same caps a file is. */}
                <p className="font-jetbrains mt-2 text-[11px] leading-relaxed text-white/45">
                  youtube.com or youtu.be, one video (not a playlist or a live stream).
                  The audio is fetched by the Gravitone box — {LIMITS_HINT}.
                </p>
                <p className="font-jetbrains mt-1 text-[11px] leading-relaxed text-white/35">
                  You will be asked to attest that you have the right to use the recording
                  before anything is cloned.
                </p>
              </div>
            )}

            {srcTab === "file" && (
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
            )}
            {/* Driven by what this flow will actually DO (extend mode, armed
                with a character) rather than by "a commit happened once" —
                which RESET used to leave behind for a brand-new flow to read. */}
            {mode === "extend" && extendCid && (
              <p className="font-jetbrains mt-3 text-[12px] text-cyan-300/80">
                {returningTo
                  ? `Extending ${returningTo} — the voices you commit attach to it, and you land back on its page.`
                  : "Extending an existing character with more emotions."}
              </p>
            )}
            {/* The inbound link named a character this roster does not have.
                Rose: the thing the link asked for did not happen. Nothing is
                pre-armed, so say which character and what the flow will do
                instead — a silent fallback to "New character" would quietly
                create a duplicate. */}
            {fromUnknown && (
              <ErrorBanner>
                “{fromUnknown}” is not one of your cloned characters, so nothing was
                pre-selected — this scan will create a NEW character unless you pick one
                to extend below.
              </ErrorBanner>
            )}
            {fromCid && rosterFailed && !rosterLoaded && (
              <ErrorBanner severity="warning">
                Your characters could not be loaded, so the character you came from could not
                be pre-selected. Reload to retry — nothing about your recording is affected.
              </ErrorBanner>
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
                  This panel used to re-type the sovereign limits by hand, so the
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
            {srcTab === "file" ? (
              <Button onClick={startScan} disabled={!file || pending !== null} className="mt-5 cursor-pointer">
                {pending === "scan" ? "Uploading & starting…" : "Scan recording →"}
              </Button>
            ) : (
              // The fetch happens on the box and is allowed 240s by the proxy;
              // without a pending state the page would look inert for the whole
              // download.
              // The button states what it will DO — including that it will take
              // only the head of a long video — and it stays disabled until the
              // verdict is in, because "scan" on an unchecked link is exactly
              // the two-minute wait this direction removes.
              <Button onClick={startLinkScan} disabled={!linkUsable || pending !== null} className="mt-5 cursor-pointer">
                {pending === "scan"
                  ? "Fetching audio…"
                  : linkProbe.status === "done" && linkProbe.verdict.trimmed
                    ? `Scan the first ${Math.round((linkProbe.verdict.clip_seconds ?? 0) / 60)} minutes →`
                    : "Scan this link →"}
              </Button>
            )}
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
        {phase === "review" && result && (() => {
        // The pipeline scores every stem it writes; the column exists only when
        // that produced something to say (see identityMeasured).
        const showIdentity = identityMeasured(result.stems, dirty);
        const cols = showIdentity ? 8 : 7;
        return (
          <div className="mt-8">
            <div className="font-jetbrains flex flex-wrap gap-4 text-[12px] text-white/60">
              <span>{result.duration}s audio</span>
              <span>
                {/* Sovereign mode used to say "single speaker assumed (no local
                    diarization)" unconditionally. It can now separate speakers
                    offline (service/ingest.py::diarize_segments), so that was
                    about to become false — and the count it reports is a
                    hypothesis in that mode either way (assumed without the
                    diarizer, clustered with it). Say the count, and say that. */}
                {`${result.speakers.length} speaker${result.speakers.length === 1 ? "" : "s"}`}
                {result.mode === "sovereign" && " · local scan, the count is not certain"}
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
                <p className="mt-1 max-w-2xl text-sm text-white/60">
                  Keep or descope each emotion. “Short” stems hold under{" "}
                  {result.min_stem}s of audio, the minimum this backend clones from.
                  Play <span className="text-white/80">stem</span> to hear the speaker&apos;s own
                  recording, or <span className="text-cyan-200">as a voice</span> to hear the
                  clone itself — before anything is created. Open the{" "}
                  <span className="text-white/80">segment count</span> to hear what a stem is
                  spliced from, and to exclude or move a segment.
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
                    {/* What the pipeline MEASURED about the stem it just wrote.
                        It has always been served per stem and never shown. */}
                    {showIdentity && (
                      <th className="px-3 py-2 text-left font-normal">identity</th>
                    )}
                    <th className="px-3 py-2 text-left font-normal">vocal cue</th>
                    {/* Two different things to listen to, so both are named:
                        the source recording, and the clone of it. */}
                    <th className="w-44 px-3 py-2 text-left font-normal">listen</th>
                    <th className="w-28 px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {result.stems.map((st) => {
                    const on = selected.has(st.emotion);
                    const m = emotionMeta(st.emotion);
                    // The candidate takes for this row (>=2 or nothing at all),
                    // the one the ear chose, and the state of the quick clone.
                    const takesFor = candidates(st);
                    const chosen = recipeById(st, auditions[st.emotion]);
                    const quick = takes[takeKey(st.emotion, auditions[st.emotion] ?? "full", "")];
                    const open = auditionFor === st.emotion;
                    // The segment layer only exists once the backend published
                    // it; absent = the row simply does not expand.
                    const board = boardFor === st.emotion;
                    const castable = Boolean(result.segments?.length
                      && assignments[st.emotion]?.length);
                    const cast = isEdited(dirty, st.emotion);
                    return (
                      <Fragment key={st.emotion}>
                      <tr className={`border-b border-white/5 transition hover:bg-white/[0.03] ${on ? "" : "opacity-55"}`}>
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
                            {/* A stem the USER assembled is never presented as
                                the pipeline's proposal. */}
                            {cast && <span className="font-jetbrains rounded bg-cyan-400/10 px-1.5 py-0.5 text-[10px] text-cyan-200">cast</span>}
                          </span>
                          {st.note && <span className="mt-1 block max-w-[26rem] text-[11px] leading-snug text-amber-200/70">{st.note}</span>}
                          {/* What the EAR chose, stated where the emotion is
                              named — a decision the user made must be visible
                              at commit time, not buried in a closed panel. */}
                          {chosen && !chosen.default && (
                            <span className="font-jetbrains mt-1 flex items-center gap-1.5 text-[10px] text-cyan-200/85">
                              cloning “{chosen.label}” · {chosen.seconds}s
                              <button
                                onClick={() => dispatch({ type: "CHOOSE_RECIPE", emotion: st.emotion, recipeId: null })}
                                title="clone the full stem instead"
                                className="cursor-pointer text-white/45 underline decoration-dotted transition hover:text-white"
                              >
                                undo
                              </button>
                            </span>
                          )}
                        </td>
                        <td className="font-jetbrains px-3 py-2 text-[12px] text-white/70">{st.seconds}s</td>
                        <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">
                          {castable ? (
                            <button onClick={() => setBoardFor(board ? null : st.emotion)}
                              aria-expanded={board}
                              aria-label={`${board ? "Hide" : "Show"} the ${st.segments} segments in the ${m.label} stem`}
                              title="what this stem is spliced from — play, exclude or move each segment"
                              className="cursor-pointer underline decoration-dotted underline-offset-4 transition hover:text-white">
                              {st.segments} {board ? "▾" : "▸"}
                            </button>
                          ) : (
                            st.segments
                          )}
                        </td>
                        {showIdentity && (() => {
                          const cell = stemIdentity(st, cast, result.fidelity?.measures);
                          return (
                            <td className="font-jetbrains px-3 py-2 text-[12px]" title={cell.title}>
                              <span className={
                                cell.tone === "measured" ? "tabular-nums text-cyan-200/85"
                                : cell.tone === "recast" ? "text-white/45"
                                : "text-white/35"}>
                                {cell.text}
                              </span>
                            </td>
                          );
                        })()}
                        <td className="px-3 py-2 text-[12px] italic text-white/50">{st.cues[0] ? `“${st.cues[0]}”` : "—"}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {/* SOURCE audio: the speaker's own recording. */}
                            <button onClick={() => playClip(`/api/ingest/${jobId}/preview/${st.emotion}`, `stem-${st.emotion}`)}
                              aria-label={`${playing === `stem-${st.emotion}` ? "Pause" : "Play"} the source recording for ${m.label}`}
                              title="source audio — the speaker's own recording"
                              className="font-jetbrains flex cursor-pointer items-center gap-1.5 rounded-full border border-white/15 px-2.5 py-1 text-[11px] text-white/75 transition hover:border-white/35 hover:text-white">
                              <span aria-hidden>{playing === `stem-${st.emotion}` ? "⏸" : "▶"}</span>
                              stem
                            </button>
                            {/* CLONED voice: what committing this row would make. */}
                            <button onClick={() => void hearAsVoice(st)}
                              disabled={quick?.loading}
                              aria-label={`${playing === `voice-${st.emotion}` ? "Pause" : "Play"} ${m.label} as a cloned voice`}
                              title="cloned voice — synthesized from this stem, before anything is committed"
                              className="font-jetbrains flex cursor-pointer items-center gap-1.5 rounded-full border border-cyan-400/35 bg-cyan-400/10 px-2.5 py-1 text-[11px] text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-default disabled:opacity-45">
                              <span aria-hidden>{quick?.loading ? "◌" : playing === `voice-${st.emotion}` ? "⏸" : "▶"}</span>
                              {quick?.loading ? "cloning…" : "as a voice"}
                            </button>
                          </div>
                          {/* A refused or failed audition says so here, in amber:
                              nothing about the ledger row has gone wrong. */}
                          {quick?.error && (
                            <span className="font-jetbrains mt-1 block max-w-[16rem] text-[10px] leading-snug text-amber-200/80">
                              {quick.error}
                              {quick.busySec ? ` — retry in ${quick.busySec}s.` : ""}
                            </span>
                          )}
                          {takesFor.length > 0 && (
                            <button onClick={() => setAuditionFor(open ? null : st.emotion)}
                              aria-expanded={open}
                              aria-label={`${open ? "Close" : "Open"} the audition for ${m.label}`}
                              className="font-jetbrains mt-1.5 cursor-pointer text-[10px] text-white/45 underline decoration-dotted transition hover:text-white">
                              {open ? "close audition" : `compare ${takesFor.length} takes →`}
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button onClick={() => dispatch({ type: "TOGGLE_EMOTION", emotion: st.emotion })} aria-pressed={on}
                            className={`font-jetbrains rounded-lg border px-2.5 py-1 text-[11px] transition ${on ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/55 hover:text-white"}`}>
                            {on ? "✓ keep" : "descope"}
                          </button>
                        </td>
                      </tr>
                      {board && (
                        <tr className="border-b border-white/5">
                          <td colSpan={cols} className="px-3 pb-4 pt-1">
                            <SegmentBoard
                              jobId={jobId!}
                              stem={st}
                              result={result}
                              minStem={result.min_stem}
                              assignments={assignments}
                              edited={cast}
                              busy={casting.busy}
                              error={casting.error}
                              onCast={castSegments}
                              onReset={casting.reset}
                              onDismissError={casting.dismiss}
                              onClose={() => setBoardFor(null)}
                            />
                          </td>
                        </tr>
                      )}
                      {open && (
                        <tr className="border-b border-white/5">
                          <td colSpan={cols} className="px-3 pb-4 pt-1">
                            <AuditionPanel
                              emotion={st.emotion}
                              label={m.label}
                              hue={m.hue}
                              recipes={takesFor}
                              chosenId={auditions[st.emotion]}
                              takes={takes}
                              request={requestTake}
                              play={playClip}
                              playing={playing}
                              onChoose={(recipeId) => dispatch({ type: "CHOOSE_RECIPE", emotion: st.emotion, recipeId })}
                              onClose={() => setAuditionFor(null)}
                            />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* Why there is nothing to compare, when the backend knows. Named
                rather than silent, and never dressed up as a failure. */}
            {job?.recipes?.unavailable && (
              <p className="font-jetbrains mt-2 text-[11px] text-white/40">
                alternative takes aren&apos;t available for this scan — {job.recipes.unavailable}.
                You can still hear each emotion as a voice.
              </p>
            )}

            <div className="glass-panel mt-6 max-w-2xl rounded-2xl p-5">
              <div className="flex gap-2">
                <button onClick={() => dispatch({ type: "SET_MODE", mode: "new" })} className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] ${mode === "new" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60"}`}>New character</button>
                <button onClick={() => dispatch({ type: "SET_MODE", mode: "extend" })} disabled={characters.length === 0}
                  title={rosterFailed ? "Your existing characters could not be loaded" : undefined}
                  className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] disabled:opacity-40 ${mode === "extend" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60"}`}>Extend existing</button>
              </div>
              {/* Not "you have no characters to extend" — we do not know that. */}
              {rosterFailed && (
                <ErrorBanner className="mt-3">
                  Your existing characters could not be loaded, so “Extend existing” is unavailable —
                  reload to retry. Creating a new character still works.
                </ErrorBanner>
              )}
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
              {/* The way out. Review is where a user spends the most time and
                  it was the one phase with no exit at all: a commit that failed
                  landed back HERE, and the only escape from a ledger the user
                  had given up on was reloading the page by hand. */}
              <button onClick={startOver}
                className="font-jetbrains mt-3 cursor-pointer text-[11px] text-white/45 underline decoration-dotted underline-offset-4 transition hover:text-white">
                start over with a different recording
              </button>
              {/* The attestation says what is TRUE of this recording. For a
                  pasted link, "I own this voice" is a sentence the user cannot
                  honestly tick — the video is someone else's — so a different
                  one is shown, and it is the one the backend requires verbatim
                  for a link-sourced job. Neither is optional; the checkbox
                  still gates the commit either way. */}
              <label className="mt-4 flex cursor-pointer items-start gap-2 text-[13px] text-white/70">
                <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)}
                  className="mt-0.5 accent-cyan-300" />
                <span>
                  {externalSource ? EXTERNAL_CONSENT_STATEMENT : CONSENT_STATEMENT}{" "}
                  <span className="font-jetbrains text-[11px] text-white/45">
                    (attestation stored with the voices — Voice Vault
                    {externalSource ? ", together with the link it came from" : ""})
                  </span>
                </span>
              </label>
              {externalSource && (
                <p className="font-jetbrains mt-2 text-[11px] leading-relaxed text-white/45">
                  This recording was fetched from a link, not recorded by you. Cloning a
                  voice from someone else&apos;s published audio may need their permission
                  — this attestation is stored with the voices and names the source video.
                </p>
              )}
              {/* Retention, opt-IN, and asked here because this is the consent
                  moment. Off means the recording is used to clone and then
                  discarded with the rest of the scan workdir; on means this box
                  keeps the audio and its labels for the character, under the
                  attestation above. Everything the checkbox promises is
                  inspectable and deletable from the character page, which is the
                  only thing that makes keeping it defensible. */}
              <label className="mt-3 flex cursor-pointer items-start gap-2 border-t border-white/8 pt-3 text-[13px] text-white/70">
                <input type="checkbox" checked={keepCorpus} onChange={(e) => setKeepCorpus(e.target.checked)}
                  className="mt-0.5 accent-emerald-300" />
                <span>
                  Keep this recording for the character on this machine.{" "}
                  <span className="font-jetbrains text-[11px] leading-relaxed text-white/45">
                    The audio, its segment labels and the attestation above are stored
                    on this Gravitone box — never uploaded anywhere — so the voices can
                    be rebuilt from it later, and improved as more recordings arrive.
                    You can list and delete it, one recording at a time, from the
                    character page. Leave it off and nothing of the recording survives
                    the clone.
                  </span>
                </span>
              </label>
            </div>
          </div>
        );
        })()}

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
                {cancelFailed ? "Try cancelling again" : "Cancel"}
              </button>
              {/* The cancel did not happen, and the copy names the state that
                  leaves behind rather than the one the user asked for. */}
              {cancelFailed && (
                <ErrorBanner severity="warning" className="mx-auto mt-4 max-w-xl text-left">
                  <span className="block">
                    {cancelFailed} — {CANCEL_UNFINISHED}. This screen keeps
                    following the job, so if the clone finishes you will see it.
                  </span>
                  <button onClick={startOver}
                    className="mt-2 cursor-pointer underline decoration-dotted underline-offset-4 transition hover:text-amber-100">
                    leave this screen anyway
                  </button>
                </ErrorBanner>
              )}
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
              {/* A pick that could not be honoured is STATED: the voice exists,
                  but it is not the take the user chose, and only the backend
                  knows that. Silence here would be the flow claiming the
                  audition mattered when it did not. */}
              {(job?.recipes?.skipped?.length ?? 0) > 0 && (
                <p className="font-jetbrains mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/85">
                  {job!.recipes!.skipped.map((s) => (
                    <span key={`${s.emotion}-${s.recipe}`} className="block">
                      {emotionMeta(s.emotion).label}: the take you picked wasn&apos;t used — {s.why}.
                      The full stem was cloned instead.
                    </span>
                  ))}
                </p>
              )}
              {vaultWarn && (
                <p className="font-jetbrains mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/85">
                  Voices cloned, but the consent receipt couldn’t be saved to your vault. Reload “My Voices” — if they’re missing, re-open the character to re-record ownership.
                </p>
              )}
              {/* What this box did with the RECORDING, as the service reported
                  it — always stated, including the "nothing was kept" case,
                  which is quiet rather than absent: on a page about someone's
                  voice, "we kept nothing" is worth one line, and silence is the
                  one thing indistinguishable from a capture that failed. */}
              {(() => {
                const notice = corpusNotice(job?.corpus);
                if (!notice) return null;
                if (notice.tone === "quiet") {
                  return (
                    <p className="font-jetbrains mt-3 text-[11px] text-white/40">{notice.text}</p>
                  );
                }
                if (notice.tone === "warning") {
                  return <ErrorBanner severity="warning" className="mt-3">{notice.text}</ErrorBanner>;
                }
                return (
                  <p className="font-jetbrains mt-3 rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-[11px] leading-relaxed text-emerald-200/85">
                    🔒 {notice.text}
                  </p>
                );
              })()}
              {/* Eviction is a deletion the user did not ask for, so it is named
                  with the service's own reason for each clip it took. */}
              {(job?.corpus?.pruned?.length ?? 0) > 0 && (
                <p className="font-jetbrains mt-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/85">
                  {job!.corpus!.pruned!.map((p) => (
                    <span key={p.clip_sha256} className="block">
                      an older recording was removed to make room — {p.why}.
                    </span>
                  ))}
                </p>
              )}
              {/* Each created Voice with the number measured ON IT: the clone is
                  synthesized and scored against the speaker's own reference at
                  commit, and this screen showed emotion names only. Where there
                  is no number the backend said why, and that sentence is carried
                  rather than an empty chip the user has to interpret. */}
              <div className="mt-4 flex flex-wrap gap-2">
                {created.map((c) => {
                  const m = emotionMeta(c.emotion);
                  const measured = typeof c.identity === "number";
                  return (
                    <span key={c.voice_id}
                      title={measured
                        ? "Identity match: how closely the cloned voice sounds like the "
                          + "speaker it was made from (1.00 is identical). It says nothing "
                          + "about whether the take is good."
                        : c.identity_reason
                          ? `Identity was not measured — ${c.identity_reason}`
                          : undefined}
                      className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] text-white/80">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${m.hue} 80% 62%)` }} />{m.label}
                      {measured && (
                        <span className="tabular-nums text-cyan-200/85">identity {c.identity!.toFixed(2)}</span>
                      )}
                      {!measured && c.identity_reason && (
                        <span className="text-white/40">not measured</span>
                      )}
                    </span>
                  );
                })}
              </div>
              {/* Why a number is missing, once — the reason is the same for every
                  voice in a commit (it is decided before the model loads), so it
                  is stated once rather than repeated per chip. */}
              {created.some((c) => typeof c.identity !== "number" && c.identity_reason) && (
                <p className="font-jetbrains mt-2 text-[11px] leading-relaxed text-white/40">
                  identity was not measured — {created.find((c) => c.identity_reason)!.identity_reason}.
                </p>
              )}
              {/* An extend-mode commit that OVERWROTE a voice used to say nothing
                  at all. The previous embedding is gone by the time the row is
                  swapped, so this is not a footnote — it is the outcome. */}
              {created.some((c) => c.replaced) && (
                <p className="font-jetbrains mt-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/85">
                  {created.filter((c) => c.replaced).map((c) => (
                    <span key={c.voice_id} className="block">
                      replaced the previous {emotionMeta(c.emotion).label} voice
                      {" "}({c.replaced}) — that embedding is gone.
                    </span>
                  ))}
                </p>
              )}
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
                {/* The loop closes here. When the flow was opened FROM a
                    character, the primary action names that character by the
                    name it was committed under — not "Open character", which
                    reads as somewhere new. Deliberately a click and not an
                    automatic redirect: this screen carries the skipped-take and
                    consent-receipt warnings above, and a redirect would throw
                    them away before they were read. */}
                {committedCid && (
                  <Link href={`/voices/${committedCid}`} className="rounded-full bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110">
                    {fromCid === committedCid && state.pendingCommit?.character
                      ? `Back to ${state.pendingCommit.character} →`
                      : "Open character →"}
                  </Link>
                )}
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
