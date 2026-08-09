"use client";

import { useRef, useState, type Dispatch } from "react";
import { readDetail } from "@/lib/apiFetch";
import { useMounted } from "@/lib/useMounted";
import { characterSlug } from "@/lib/slugs";
import { commitRecipes } from "./audition";
import { castMembers, castRefusal, type CastSelection } from "./cast";
import type { Action, Character, Job, Result } from "./machine";
import type { useBackpressure } from "./useBackpressure";
import { validateUpload } from "./uploadProbe";

// Which mutating call is in flight. `submitting` (a ref) still owns the atomic
// double-submit gate; this is the same fact made VISIBLE — a ref cannot put a
// button into a pending state, and the scan kickoff is allowed 120 seconds.
export type Pending = null | "scan" | "commit" | "cast" | `speaker:${string}`;

/**
 * Every call this flow makes that CHANGES something server-side, behind one
 * re-entrancy gate.
 *
 * The gate is the point: `submitting` is a ref, so it closes inside the same
 * tick a double-click opens, and `pending` is the same fact made visible. Each
 * call's 429 goes to backpressure (amber, recoverable) and never to the rose
 * `error` channel.
 */
export function useIngestActions(opts: {
  jobId: string | null;
  job: Job | null;
  result: Result | null;
  selected: Set<string>;
  mode: "new" | "extend";
  charName: string;
  extendCid: string;
  auditions: Record<string, string>;
  characters: Character[];
  file: File | null;
  setFile: (f: File | null) => void;
  link: string;
  ingestMode: "auto" | "sovereign";
  castSel: CastSelection;
  consented: boolean;
  consentStatement: string;
  keepCorpus: boolean;
  dispatch: Dispatch<Action>;
  busy: ReturnType<typeof useBackpressure>;
  pauseTransport: () => void;
}) {
  const {
    jobId, job, result, selected, mode, charName, extendCid, auditions, characters,
    file, setFile, link, ingestMode, castSel, consented, consentStatement,
    keepCorpus, dispatch, busy, pauseTransport,
  } = opts;

  const submitting = useRef(false); // re-entrancy guard for scan/speaker/commit
  const [pending, setPending] = useState<Pending>(null); // the same fact, visible
  const mounted = useMounted();

  /** Re-run the refused call through THIS render's handler (never a stale
   *  closure captured when the 429 landed — the selection may have changed). */
  function retryBusy() {
    const b = busy.notice;
    busy.clear();
    if (!b) return;
    if (b.action.kind === "scan") void startScan();
    else if (b.action.kind === "link") void startLinkScan();
    else if (b.action.kind === "speaker") void chooseSpeaker(b.action.sid);
    else if (b.action.kind === "cast") void startCast();
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
    setPending("scan"); busy.clear();
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("mode", ingestMode);
    try {
      const r = await fetch("/api/ingest/scan", { method: "POST", body: fd });
      // The ingest queue is full: the recording is fine and so is the backend.
      if (r.status === 429) { await busy.present(r, { kind: "scan" }); return; }
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
    setPending("scan"); busy.clear();
    try {
      const r = await fetch("/api/ingest/scan-url", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: link.trim(), mode: ingestMode }),
      });
      // Backpressure, not a bad link: the queue is full and the URL is fine.
      if (r.status === 429) { await busy.present(r, { kind: "link" }); return; }
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
    pauseTransport();
    submitting.current = true;
    setPending(`speaker:${sid}`); busy.clear();
    try {
      // Verify the backend accepted the speaker before advancing the state
      // machine — an expired/rejected job would otherwise spin the Waveform Lab
      // while the server is still awaiting_speaker (or gone), with no error.
      const r = await fetch(`/api/ingest/${jobId}/speaker`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speaker_id: sid }) });
      // Still on the speaker screen, job untouched server-side — offer the pick
      // again rather than reporting a session that "failed".
      if (r.status === 429) { await busy.present(r, { kind: "speaker", sid }); return; }
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

  /** Cast every ticked speaker into a Character of its own.
   *
   *  The other exit from this screen. It commits WITHOUT the review ledger —
   *  one attestation, every eligible emotion of every selected speaker — so the
   *  consent tick is taken here, and the panel says what is skipped. The
   *  single-speaker path above is untouched: it still goes to the ledger. */
  async function startCast() {
    if (submitting.current || !job?.speakers) return;
    const members = castMembers(castSel, job.speakers);
    // Refused in the browser first, in the user's own terms; the service
    // enforces every one of these again.
    const refusal = castRefusal(members) ?? (consented ? null
      : "Attest that you have the right to use this recording before cloning it.");
    if (refusal) { dispatch({ type: "SET_ERROR", error: refusal }); return; }
    pauseTransport();
    submitting.current = true;
    setPending("cast"); busy.clear();
    try {
      const r = await fetch(`/api/ingest/${jobId}/cast`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members, attested: consented, statement: consentStatement }),
      });
      // Nothing has started server-side: stay on the board with the selection
      // intact and offer the same call again.
      if (r.status === 429) { await busy.present(r, { kind: "cast" }); return; }
      if (!r.ok) throw new Error((await readDetail(r)) ?? "couldn't start the cast");
      dispatch({ type: "CAST_STARTED" });
    } catch (e) {
      dispatch({ type: "SET_ERROR", error: e instanceof Error ? e.message : "couldn't start the cast" });
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(null);
    }
  }

  async function commit() {
    if (selected.size === 0 || submitting.current) return; // guard the double-click window
    const character = mode === "new" ? charName.trim() : (characters.find((c) => c.character_id === extendCid)?.name ?? "");
    const character_id = mode === "extend" ? extendCid : undefined;
    if (mode === "new" && !character) { dispatch({ type: "SET_ERROR", error: "Name the character" }); return; }
    if (mode === "extend" && !extendCid) { dispatch({ type: "SET_ERROR", error: "Pick a character to extend" }); return; }
    const cid = character_id ?? characterSlug(character);
    submitting.current = true;
    setPending("commit"); busy.clear();
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
        await busy.present(r, { kind: "commit" });
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

  return {
    pending, acceptFile, startScan, startLinkScan, chooseSpeaker, startCast,
    commit, retryBusy,
  };
}
