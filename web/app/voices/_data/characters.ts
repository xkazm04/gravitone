"use client";

// ── ONE data layer for Character & Voice management ───────────────────────────
// The roster page (/voices) and the detail page (/voices/[id]) both consume this
// module. It owns every fetch/CRUD/preview against the /api/characters and
// /api/voices proxies, so the two pages can never drift apart again (they used
// to keep two parallel copies of the clone/delete logic). Mutations surface
// their failures to callers; nothing is swallowed.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiJson, throwDetail } from "@/lib/apiFetch";
import { CONSENT_STATEMENT } from "@/lib/consent";
import { useMounted } from "@/lib/useMounted";
import { EMOTIONS, emotionMeta, isBaseEmotion } from "@/lib/emotions";
import { useAuth } from "@/lib/useAuth";
import { recordVoiceOwnership, type ConsentMethod } from "@/lib/voiceVault";

/**
 * What the studio MEASURED about the recording a Voice was cloned from.
 *
 * Absent (`undefined`) means **not measured** — every Voice cloned before the
 * ledger existed, every built-in, and every clip whose audio could not be
 * parsed. Nothing is rendered for it: no placeholder, no "not measured" noise, no
 * zero. A zero would read as "this voice is bad", which is a claim nothing made.
 *
 * `identity` is cosine similarity to the speaker's own reference and is
 * presented as **identity match**, never as "quality" — it says whether this
 * still sounds like the same person, and nothing about whether the take is good.
 */
export type Fidelity = {
  identity?: number;
  speechSeconds?: number;
  flags: string[];
};

/** One speaker in ONE emotion. */
export type Voice = {
  voice_id: string;
  character_id: string;
  emotion: string;
  name: string;
  category: "cloned" | "premade";
  lang: string;
  created?: string | null;
  sample_seconds?: number | null;
  // True when a consent receipt is on file for this voice (ingest / attested
  // clone). Pre-consent and built-in voices report false.
  consent?: boolean;
  // Measured signal facts, normalized off the wire by `readFidelity`. Optional
  // on purpose — see the Fidelity docstring: absent renders as nothing.
  fidelity?: Fidelity;
};

/** A group of Voices across the emotion scale. */
export type Character = {
  character_id: string;
  name: string;
  category: "cloned" | "premade";
  tags: string[];
  lang: string;
  voices: Voice[];
  emotions: string[];
  coverage: number;
  total: number;
  created?: string | null;
  // Fallback telemetry: unmet requests per still-missing emotion.
  demand?: Record<string, number>;
  // This Character's effective palette: base scale + its custom slots.
  scale?: string[];
  custom_emotions?: string[];
  // Pack-import provenance when this Character came from a .gravichar import.
  imported?: { from: string; at: string } | null;
};

/** One Character's emotion scale: which slots are filled, and how to fill them. */
export type Slot = {
  emotion: string;
  label: string;
  hue: number;
  custom: boolean; // beyond the base scale — art is a generated sigil
  /** The Voice that actually SPEAKS this slot, or null for an empty slot.
   *  This is the backend's own answer, not a rule re-derived here: the service
   *  sorts `character.voices` into scale order and `_by_emotion` serves the
   *  first match, so the first match in that same list is the speaking voice. */
  voice: Voice | null;
  /** EVERY Voice registered for this emotion, speaker first. Normally 0 or 1;
   *  the registry tolerates duplicates (see `_by_emotion`) precisely so the
   *  extra ones stay visible — and therefore deletable. */
  voices: Voice[];
  demand: number; // unmet requests for this emotion (fallback telemetry)
};

// ── the fidelity ledger ───────────────────────────────────────────────────────
//
// The service reports named facts, not a score: flags that are TRUE, plus the
// numbers behind them. This half of the module turns that wire object into the
// one thing the UI shows — a single Signal chip stating the most actionable fact
// — and into the recorder direction that fixes it.
//
// Deliberately NOT a 0-100: "clipped" and "1.4s speech" are things a user can
// act on, where a 73 is a number they can only distrust. The numeric identity
// match appears as a secondary detail, never as the headline.

/** Flags in DESCENDING severity: the first one present is the one to show.
 *  Order = how much of the clone it ruins, and how fixable it is by re-recording. */
export const SIGNAL_FLAGS = ["clipped", "low_sample_rate", "noisy", "short_speech"] as const;

type FlagCopy = {
  /** The chip label. Prefers the measured number when there is one. */
  label: (f: Fidelity) => string;
  /** Why it matters — shown on hover/focus, never truncated into the chip. */
  why: string;
  /** What to do about it, addressed to someone about to record again. */
  direction: string;
};

const FLAG_COPY: Record<string, FlagCopy> = {
  clipped: {
    label: () => "clipped",
    why: "This recording hits the rail — the loudest parts are flat-topped, and that distortion is cloned into every line the voice speaks.",
    direction: "clipped — move further from the mic, or lower the input gain, and record it again",
  },
  low_sample_rate: {
    label: () => "low sample rate",
    why: "The source audio was below 16 kHz (a phone call, a compressed export), so there is no high band for the model to clone.",
    direction: "the source was low-bandwidth (below 16 kHz) — record straight into this page instead of uploading a compressed file",
  },
  noisy: {
    label: () => "noisy",
    why: "The background of this recording is loud — a fan, traffic, a live room. The model clones the room along with the voice.",
    direction: "the background was loud — a fan, traffic, a live room; record somewhere quieter",
  },
  short_speech: {
    label: (f) => (f.speechSeconds !== undefined ? `${f.speechSeconds}s speech` : "little speech"),
    why: "Most of this clip is silence. Only the speech in it teaches the model anything.",
    direction: "there was very little actual speech — aim for 10–30 seconds of talking, not of silence",
  },
};

/** One measured fact, ready to render. `flag` is null for a clean measurement. */
export type Signal = {
  flag: string | null;
  label: string;
  title: string;
  /** 0 = clean. Higher = worse, comparable across Voices (roster `weakest` sort). */
  severity: number;
};

/**
 * Read the service's fidelity object off the wire.
 *
 * The wire is snake_case and every field is independently nullable — a clip can
 * report its sample rate and nothing else. Anything unrecognisable (a
 * hand-edited registry, an older service) is treated as NOT MEASURED rather than
 * partially believed, and an object with no facts in it at all comes back
 * undefined so it renders as nothing.
 */
export function readFidelity(raw: unknown): Fidelity | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const flags = Array.isArray(o.flags)
    ? o.flags.filter((f): f is string => typeof f === "string")
    : [];
  const f: Fidelity = {
    identity: num(o.identity),
    speechSeconds: num(o.speech_seconds),
    flags,
  };
  if (f.identity === undefined && f.speechSeconds === undefined && flags.length === 0) {
    return undefined; // nothing to say — say nothing
  }
  return f;
}

/** The one fact worth a chip, or null when there is nothing measured to state. */
export function signalOf(fidelity?: Fidelity): Signal | null {
  if (!fidelity) return null;
  for (let i = 0; i < SIGNAL_FLAGS.length; i++) {
    const flag = SIGNAL_FLAGS[i];
    if (!fidelity.flags.includes(flag)) continue;
    const copy = FLAG_COPY[flag];
    return {
      flag,
      label: copy.label(fidelity),
      title: copy.why,
      severity: SIGNAL_FLAGS.length - i,
    };
  }
  // An unknown flag from a newer service is still a real finding — name it
  // verbatim rather than dropping it, and rank it below the ones we understand.
  const unknown = fidelity.flags[0];
  if (unknown) {
    return { flag: unknown, label: unknown.replace(/_/g, " "), severity: 1,
             title: `The service flagged “${unknown}” on this recording.` };
  }
  if (fidelity.identity !== undefined) {
    return {
      flag: null,
      label: `identity ${fidelity.identity.toFixed(2)}`,
      title: "Identity match: how closely this take still sounds like the same "
        + "speaker (1.00 is identical). It says nothing about whether the take is good.",
      severity: 0,
    };
  }
  if (fidelity.speechSeconds !== undefined) {
    return { flag: null, label: `${fidelity.speechSeconds}s speech`, severity: 0,
             title: "Effective speech in the recording this voice was cloned from — "
               + "silence excluded." };
  }
  return null;
}

/** What to tell someone re-recording this slot, or null if nothing is wrong. */
export function defectDirection(fidelity?: Fidelity): string | null {
  const signal = signalOf(fidelity);
  if (!signal?.flag) return null;
  return FLAG_COPY[signal.flag]?.direction ?? null;
}

/** This Character's weakest measured Voice — the one to re-record next.
 *
 *  Only FLAGGED voices count: a roster of clean takes has no weakest one, and
 *  inventing a ranking over measurements that all came back fine would send the
 *  user to re-record something that is not broken. Unmeasured voices are not
 *  candidates either — absence is not a defect. */
export function weakestVoice(c: Character): { voice: Voice; signal: Signal } | null {
  let worst: { voice: Voice; signal: Signal } | null = null;
  for (const voice of c.voices) {
    const signal = signalOf(voice.fidelity);
    if (!signal?.flag) continue;
    if (!worst || signal.severity > worst.signal.severity) worst = { voice, signal };
  }
  return worst;
}

/** Sort weight for the roster's `weakest` column: 0 = nothing flagged. */
export function weaknessOf(c: Character): number {
  return weakestVoice(c)?.signal.severity ?? 0;
}

export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function relTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return "—";
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── the shared roster request ─────────────────────────────────────────────────
// ONE way to ask for the character list. The playground kept its own
// `apiJson("/api/characters")` next to this module's, so the app had two
// truths about which Characters exist (and the rail and the script <select>
// could disagree). The create flow (voices/new) kept a THIRD, whose .catch set
// [] and so rendered a failed read as "you have no characters to extend". All
// three now call loadRoster() — which is what makes that claim true.
//
// Deliberately NOT a time-based cache. A previous fetch-reduction round in this
// repo shipped a roster that stayed stale after a clone; the win here is
// concurrency and one code path, not skipped requests. This only shares a
// request that is IN FLIGHT AT THIS MOMENT, so every mount still sees server
// truth, and any mutation detaches the in-flight request (invalidateRoster) so
// a post-mutation refresh can never be served pre-mutation data.
/**
 * Map ONE character off the wire into the shape this app's types promise.
 *
 * The only translation is the fidelity object (snake_case, independently
 * nullable fields — see `readFidelity`), and it happens HERE, at the single
 * fetch boundary, so no component has to know what the service's JSON looks
 * like and no two components can disagree about it.
 */
export function normalizeCharacter(c: Character): Character {
  // A payload with no voices array has nothing to normalize, and inventing an
  // empty one would turn "the response was partial" into "this Character has no
  // voices" — the same absent-vs-zero mistake the ledger exists to avoid.
  if (!c || !Array.isArray(c.voices)) return c;
  return {
    ...c,
    voices: c.voices.map((v) => {
      const fidelity = readFidelity((v as { fidelity?: unknown }).fidelity);
      return fidelity ? { ...v, fidelity } : { ...v, fidelity: undefined };
    }),
  };
}

type RosterReq = { promise: Promise<Character[]>; ctrl: AbortController; waiters: number };
let current: RosterReq | null = null;

function abortError(): DOMException {
  return new DOMException("roster load aborted", "AbortError");
}

/**
 * Load the character roster, sharing an already in-flight request.
 *
 * `signal` genuinely aborts: the caller's promise rejects with an AbortError
 * immediately, and the underlying request is cancelled once NOBODY is waiting
 * for it any more (cancelling a shared request out from under another mounted
 * component would be the obvious way to get this wrong).
 */
export function loadRoster(signal?: AbortSignal): Promise<Character[]> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!current) {
    const ctrl = new AbortController();
    const req: RosterReq = { ctrl, waiters: 0, promise: null as never };
    req.promise = apiJson<Character[]>(
      "/api/characters", { cache: "no-store", signal: ctrl.signal },
      "failed to load characters",
    ).then((cs) => cs.map(normalizeCharacter))
      .finally(() => { if (current === req) current = null; });
    current = req;
  }
  const req = current;
  req.waiters += 1;
  let released = false;
  const release = () => { if (!released) { released = true; req.waiters -= 1; } };

  if (!signal) return req.promise.finally(release);

  return new Promise<Character[]>((resolve, reject) => {
    const onAbort = () => {
      release();
      // Last one out cancels the request; otherwise it keeps serving the others.
      if (req.waiters <= 0) req.ctrl.abort();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    req.promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); release(); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); release(); reject(e); },
    );
  });
}

/** A mutation just changed the roster: detach the in-flight request so the next
 *  loadRoster() starts a fresh one. Callers already waiting still get their
 *  answer — it simply stops being handed to anyone new. */
export function invalidateRoster(): void {
  current = null;
}

// ── request helpers ───────────────────────────────────────────────────────────
// Failure→message conversion lives in lib/apiFetch (shared with every data
// layer); every mutation below routes through it so callers get a real message
// to show, never silence.
async function fetchRoster(): Promise<Character[]> {
  return loadRoster();
}

/** Fetch ONE Character (the detail page). Returns null on 404 so the page can
 *  render its "no such character" state. Downloading the whole roster to
 *  `.find()` a single character was the old, wasteful path. */
async function fetchCharacter(id: string): Promise<Character | null> {
  const r = await fetch(`/api/characters/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) return throwDetail(r, `error ${r.status}`);
  return normalizeCharacter((await r.json()) as Character);
}

/** Clone one Voice (character + emotion) from a recording. Throws on failure. */
export async function cloneVoice(
  character: string,
  emotion: string,
  file: Blob,
  opts: { tags?: string[]; filename?: string } = {},
): Promise<Voice> {
  const fd = new FormData();
  fd.append("file", file, opts.filename ?? (file as File).name ?? "recording.wav");
  fd.append("character", character);
  fd.append("emotion", emotion);
  fd.append("tags", (opts.tags ?? []).join(","));
  fd.append("attested", "true"); // ownership attestation (gated in the UI)
  fd.append("statement", CONSENT_STATEMENT);
  const r = await fetch("/api/voices", { method: "POST", body: fd });
  if (!r.ok) return throwDetail(r, `clone failed (${r.status})`);
  invalidateRoster(); // the roster now has a voice (or a character) it didn't
  const v = (await r.json()) as Voice;
  // The clone response carries the measurement taken at clone time; normalize it
  // through the SAME reader the roster uses so a caller can show the chip
  // immediately instead of waiting for a re-read.
  return { ...v, fidelity: readFidelity((v as { fidelity?: unknown }).fidelity) };
}

/** Delete a cloned Voice. Throws on failure (404 included — the slot is gone). */
export async function deleteVoiceReq(voiceId: string): Promise<void> {
  const r = await fetch(`/api/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
  if (!r.ok) return throwDetail(r, "delete failed");
  invalidateRoster();
}

/** Rename / retag a Character; returns the server-normalized Character. */
export async function patchCharacterReq(
  id: string,
  patch: { name?: string; tags?: string[] },
): Promise<Character> {
  const r = await fetch(`/api/characters/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) return throwDetail(r, `update failed (${r.status})`);
  invalidateRoster();
  return (await r.json()) as Character;
}

export async function deleteCharacterReq(id: string): Promise<void> {
  const r = await fetch(`/api/characters/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) return throwDetail(r, "delete failed");
  invalidateRoster();
}

export async function addCustomEmotionReq(id: string, name: string): Promise<void> {
  const r = await fetch(`/api/characters/${encodeURIComponent(id)}/emotions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) return throwDetail(r, `could not add "${name}"`);
  invalidateRoster();
}

export async function removeCustomEmotionReq(id: string, emotion: string): Promise<void> {
  const r = await fetch(
    `/api/characters/${encodeURIComponent(id)}/emotions/${encodeURIComponent(emotion)}`,
    { method: "DELETE" },
  );
  if (!r.ok && r.status !== 404) return throwDetail(r, "could not remove the slot");
  invalidateRoster();
}

// ── destruction: the question, and the honest answer when it fails ────────────
//
// Deleting a cloned Voice destroys an embedding the user may not be able to
// make again — the original recording is the only way back — and deleting a
// Character destroys every one of them at once. These were the ONLY actions on
// this surface that happened on a single click, while the consent gate
// (`voiceVault.CONSENT_PROMPT`) and the import rename already ask with a native
// dialog. Same idiom, asked here too: these builders write the question, the
// call site passes it to window.confirm.

const NO_UNDO =
  "This cannot be undone: the cloned embedding is deleted from the engine, and " +
  "only the original recording can make it again.";

/** The question before destroying ONE Voice (one emotion of one Character). */
export function deleteVoiceQuestion(
  characterName: string, label: string, voiceId: string, shadowed = false,
): string {
  return shadowed
    ? `Delete the shadowed ${label} voice of ${characterName} (${voiceId})?\n\n` +
      `The voice that actually speaks this slot is kept.\n\n${NO_UNDO}`
    : `Delete the ${label} voice of ${characterName} (${voiceId})?\n\n` +
      `${characterName} will have no ${label} voice until you record it again.\n\n${NO_UNDO}`;
}

/** The question before destroying a Character AND every Voice under it. */
export function deleteCharacterQuestion(c: Character): string {
  const n = c.voices.length;
  return `Delete ${c.name} and ${n === 1 ? "its 1 voice" : `all ${n} of its voices`}?\n\n${NO_UNDO}`;
}

/** The question before a BULK delete. It names the count (and who) — "are you
 *  sure?" over a selection the user can no longer see is not a question. */
export function bulkDeleteQuestion(cs: Character[]): string {
  const voices = cs.reduce((n, c) => n + c.voices.length, 0);
  const names = cs.slice(0, 5).map((c) => c.name).join(", ")
    + (cs.length > 5 ? `, +${cs.length - 5} more` : "");
  return `Delete ${cs.length} character${cs.length === 1 ? "" : "s"} and `
    + `${voices} voice${voices === 1 ? "" : "s"}?\n\n${names}\n\n${NO_UNDO}`;
}

function detailOf(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

function statusOf(e: unknown): number | null {
  return e instanceof ApiError ? e.status : null;
}

/**
 * What SURVIVED a failed voice delete, said out loud.
 *
 * The backend is more specific than "delete failed" ever was: when the
 * embedding cannot be unlinked it keeps the registry row too, so the Voice is
 * "unchanged rather than half-deleted" and answers a 500
 * (`service/voices.py::delete_voice`). A 404 is the opposite state — the Voice
 * is not there at all. Copy that names the WRONG surviving state is the same
 * bug as no copy, so the two are never collapsed.
 */
export function deleteVoiceFailure(e: unknown, label: string): string {
  const msg = detailOf(e, "delete failed");
  if (statusOf(e) === 404) return `${msg} — the ${label} voice was already gone.`;
  if (statusOf(e) === 500)
    return `${msg} — the ${label} voice was NOT deleted: it is still there and still usable.`;
  return `${msg} — the ${label} voice was not deleted; it is still there.`;
}

/** The same, for a Character. A 500 here means a PARTIAL delete: the voices
 *  whose embeddings did unlink are gone, the rest kept their rows, and the
 *  Character survives (`service/voices.py::delete_character` only drops the
 *  character row when nothing failed). Saying "still in your roster" is true in
 *  every failure case; claiming nothing happened would not be. */
export function deleteCharacterFailure(e: unknown, name: string): string {
  const msg = detailOf(e, "delete failed");
  if (statusOf(e) === 404) return `${msg} — “${name}” was already gone from the registry.`;
  if (statusOf(e) === 500)
    return `${msg} — “${name}” is still in your roster; some of its voices may already have been deleted.`;
  return `${msg} — “${name}” was not deleted and is still in your roster.`;
}

/** A failed rename/retag leaves the Character exactly as it was: `mutate_meta`
 *  either saves the whole edit or none of it. */
export function patchCharacterFailure(e: unknown, name: string): string {
  const msg = detailOf(e, "update failed");
  if (statusOf(e) === 404) return `${msg} — “${name}” is no longer in the registry.`;
  return `${msg} — “${name}” is unchanged.`;
}

// ── collision messages ────────────────────────────────────────────────────────
/**
 * The Voice a slot-collision 409 names, resolved against the roster.
 *
 * The backend writes "'sarah' already has a 'baseline' voice (v_ab12) — delete
 * or re-slot that voice first": it names the holder ON PURPOSE so the UI can
 * point at it. Rendered as raw text, that id is something the user has to hunt
 * for by hand, so callers use this to turn it into a link.
 *
 * Returns null when the message names nothing we can find — never a guess.
 */
export function collisionVoice(
  message: string,
  characters: Character[],
): { voice: Voice; character: Character } | null {
  for (const m of message.matchAll(/\(([^()\s]+)\)/g)) {
    for (const character of characters) {
      const voice = character.voices.find((v) => v.voice_id === m[1]);
      if (voice) return { voice, character };
    }
  }
  return null;
}

// ── roster hook ───────────────────────────────────────────────────────────────
export function useCharacters() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Did the last READ fail? `characters` staying [] after a failure is
  // indistinguishable from a new install, and the roster rendered "No
  // characters match." underneath its own error banner. `error` cannot answer
  // this — a mutation sets it too, and a failed rename must not turn a
  // genuinely empty roster into "unavailable". So the read reports separately.
  const [readFailed, setReadFailed] = useState(false);
  const mounted = useMounted();

  const refresh = useCallback(async () => {
    try {
      const roster = await fetchRoster();
      if (!mounted.current) return;
      setCharacters(roster);
      setReadFailed(false);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setReadFailed(true);
      setError(e instanceof Error ? e.message : "failed to load characters");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [mounted]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Clone one Voice from a recording. Throws so the caller's banner can show it. */
  const createVoice = useCallback(
    async (file: Blob, character: string, emotion: string, tags: string[] = [], filename = "recording.wav") => {
      const v = await cloneVoice(character, emotion, file, { tags, filename });
      await refresh();
      return v;
    },
    [refresh],
  );

  // Both optimistic mutations below roll back from a SNAPSHOT taken before the
  // paint, never from a second `refresh()`: that second request can fail too,
  // and when it did the wrong row stayed on screen under a second error. This
  // is the shape `app/keys/_variants/data.ts::revokeKey` establishes.
  const patchCharacter = useCallback(async (id: string, patch: { name?: string; tags?: string[] }) => {
    const snapshot = characters;
    const name = characters.find((c) => c.character_id === id)?.name ?? id;
    setCharacters((cs) => cs.map((c) => (c.character_id === id ? { ...c, ...patch } : c))); // optimistic
    try {
      const updated = await patchCharacterReq(id, patch);
      if (!mounted.current) return;
      // Re-sync from the server so normalized values (lowercased tags, trimmed
      // name) replace the optimistic guess.
      setCharacters((cs) => cs.map((c) => (c.character_id === id ? updated : c)));
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setCharacters(snapshot); // the edit did not land — put back what was there
      setError(patchCharacterFailure(e, name));
    }
  }, [characters, mounted]);

  // Ids with a DELETE in flight. A ref because the gate has to hold within the
  // same tick (a double-click is two clicks before any re-render), mirrored
  // into state so the row can disable its own button.
  const deletingRef = useRef<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  const deleteCharacter = useCallback(async (id: string) => {
    if (deletingRef.current.has(id)) return; // in-flight gate
    deletingRef.current.add(id);
    setDeleting(new Set(deletingRef.current));
    const snapshot = characters;
    const name = characters.find((c) => c.character_id === id)?.name ?? id;
    setCharacters((cs) => cs.filter((c) => c.character_id !== id)); // optimistic
    try {
      await deleteCharacterReq(id);
      if (mounted.current) setError(null);
    } catch (e) {
      if (!mounted.current) return;
      // A 404 means it was not in the registry to begin with — the row really
      // is gone, so restoring it would be the lie. Every other failure leaves
      // the Character standing, so the row comes back with it.
      if (!(e instanceof ApiError && e.status === 404)) setCharacters(snapshot);
      setError(deleteCharacterFailure(e, name));
    } finally {
      deletingRef.current.delete(id);
      if (mounted.current) setDeleting(new Set(deletingRef.current));
    }
  }, [characters, mounted]);

  return { characters, loading, error, readFailed, deleting, refresh, createVoice, patchCharacter, deleteCharacter };
}

// ── slot assembly ───────────────────────────────────────────────────────────
/**
 * A Character's emotion scale, as slots.
 *
 * The scale is the Character's own palette (base scale + its custom slots),
 * falling back to the base eight while the character is still loading.
 *
 * A slot carries EVERY Voice registered for its emotion, not just the first.
 * The registry deliberately tolerates two voices on one emotion — "a Voice that
 * is invisible is also undeletable" — and this used to take `.find()`, so the
 * shadowed voice had no row, no id and no remove button: the API kept the
 * duplicate fixable and the UI was the reason it wasn't. `voice` (the one that
 * speaks) is simply the FIRST of them, which is the backend's answer rather
 * than a rule re-derived here: the service pre-sorts `voices` into scale order
 * and `_by_emotion` serves the first match from that same list.
 */
export function buildSlots(character: Character | null): Slot[] {
  const scale = character?.scale?.length ? character.scale : EMOTIONS.map((e) => e.id);
  return scale.map((id) => {
    const m = emotionMeta(id);
    const voices = character?.voices.filter((v) => v.emotion === id) ?? [];
    return {
      emotion: id,
      label: m.label,
      hue: m.hue,
      custom: !isBaseEmotion(id),
      voice: voices[0] ?? null,
      voices,
      demand: character?.demand?.[id] ?? 0,
    };
  });
}

// ── detail hook ─────────────────────────────────────────────────────────────
/** One Character's emotion scale: which slots are filled, and how to fill them. */
export function useCharacter(characterId: string) {
  const { user } = useAuth();
  const [character, setCharacter] = useState<Character | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // ONLY a 404 means "no such character". Everything else — a 503 from a
  // corrupt registry, a dead backend — used to fall through to the same
  // dead-end, telling the user their character does not exist when the truth
  // was that we could not find out.
  const [notFound, setNotFound] = useState(false);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  // Consent-receipt failures are a WARNING, not a clone failure: the voice
  // exists, its provenance record doesn't.
  const [vaultWarning, setVaultWarning] = useState<string | null>(null);
  const mounted = useMounted();

  const refresh = useCallback(async () => {
    try {
      const c = await fetchCharacter(characterId);
      if (!mounted.current) return;
      setCharacter(c);
      setNotFound(c === null); // fetchCharacter maps ONLY 404 to null
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setNotFound(false); // a failed read is not an absent character
      setError(e instanceof Error ? e.message : "failed to load character");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [characterId, mounted]);

  useEffect(() => { void refresh(); }, [refresh]);

  const slots = buildSlots(character);

  /** Mint a new custom emotion slot on this Character. */
  const addCustomEmotion = useCallback(async (name: string) => {
    await addCustomEmotionReq(characterId, name);
    await refresh();
  }, [characterId, refresh]);

  /** Remove an EMPTY custom slot (the backend 409s if a Voice occupies it). */
  const removeCustomEmotion = useCallback(async (emotion: string) => {
    await removeCustomEmotionReq(characterId, emotion);
    await refresh();
  }, [characterId, refresh]);

  /** Clone a new Voice into an empty emotion slot.
   *  `rethrow` lets callers with their own error UI (GuidedRecorder) get the
   *  failure instead of the hook's shared error banner. `consent` names how
   *  the audio was obtained — it becomes the Voice Vault attestation. */
  const addVoice = useCallback(
    async (emotion: string, file: File, opts: { rethrow?: boolean; consent?: ConsentMethod } = {}) => {
      if (!character) return;
      setBusySlot(emotion);
      setError(null);
      try {
        const v = await cloneVoice(character.name, emotion, file, { filename: file.name });
        if (user) {
          // recordVoiceOwnership RETURNS {saved, failed} precisely so the
          // caller can say "consent receipt not saved" — dropping it meant a
          // clone succeeded, its provenance record didn't, and nobody knew.
          const res = await recordVoiceOwnership(user, [{
            voice_id: v.voice_id, character_id: v.character_id,
            character_name: character.name, emotion: v.emotion,
          }], opts.consent ?? "uploaded");
          setVaultWarning(res.failed > 0
            ? "voice cloned, but its consent receipt could not be saved to your vault"
            : null);
        }
        await refresh();
      } catch (e) {
        if (opts.rethrow) throw e;
        setError(e instanceof Error ? e.message : "clone failed");
      } finally {
        setBusySlot(null);
      }
    },
    [character, refresh, user],
  );

  // The voice id with a DELETE in flight (ref for the same-tick double-click
  // gate, state so the rack can disable the button that fired it).
  const removingRef = useRef<string | null>(null);
  const [removingVoiceId, setRemovingVoiceId] = useState<string | null>(null);

  const removeVoice = useCallback(
    async (voiceId: string) => {
      if (removingRef.current) return; // in-flight gate
      removingRef.current = voiceId;
      setRemovingVoiceId(voiceId);
      // Name the slot in the failure message from the roster we already have —
      // "delete failed" over a rack of eight rows does not say which one.
      const found = character?.voices.find((v) => v.voice_id === voiceId);
      const label = found ? emotionMeta(found.emotion).label : voiceId;
      setError(null);
      try {
        await deleteVoiceReq(voiceId);
        await refresh();
      } catch (e) {
        if (!mounted.current) return;
        setError(deleteVoiceFailure(e, label));
        // A 404 says the Voice is not there; the rack is the stale one, so it
        // has to re-read. Every other failure left the Voice intact, and the
        // rack is already showing exactly that — re-reading would only risk a
        // second failure on top of the first.
        if (e instanceof ApiError && e.status === 404) await refresh();
      } finally {
        removingRef.current = null;
        if (mounted.current) setRemovingVoiceId(null);
      }
    },
    [character, mounted, refresh],
  );

  const coverage = slots.filter((s) => s.voice).length;

  return { character, slots, coverage, total: slots.length, loading, error, notFound, busySlot,
           vaultWarning, removingVoiceId, addVoice, removeVoice, addCustomEmotion,
           removeCustomEmotion, refresh };
}

// ── preview hook ────────────────────────────────────────────────────────────
/** Synthesize a short line with one Voice and play it. One preview at a time.
 *  A failed preview surfaces briefly as `failedId` — WITH the reason it failed
 *  (`failedReason`). The bare `catch {}` here used to throw the backend's own
 *  detail away, so "the voice registry is unreadable", a 429 backpressure
 *  reply and a browser that blocked autoplay all read as "preview failed". */
export function useVoicePreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null); // current preview blob URL, so it can be revoked
  const failTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [failedReason, setFailedReason] = useState<string | null>(null);

  const revokeUrl = useCallback(() => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
  }, []);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    revokeUrl();
    setPlayingId(null);
  }, [revokeUrl]);

  const preview = useCallback(
    async (voiceId: string, label: string, line?: string) => {
      if (playingId === voiceId) return stop();
      stop();
      setFailedId(null);
      setFailedReason(null);
      if (failTimer.current) clearTimeout(failTimer.current);
      setBusyId(voiceId);
      try {
        const text = line ?? `Hi, this is ${label}. This is how I sound.`;
        const r = await fetch("/api/tts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voiceId }),
        });
        // The backend's `detail` is written to be shown; route it through the
        // one conversion (503 → "Gravitone backend unreachable", &c.).
        if (!r.ok) await throwDetail(r, `preview failed (${r.status})`);
        const url = URL.createObjectURL(await r.blob());
        // The unmount cleanup already ran if we got here after teardown, so it
        // will never see this URL — revoke it now or it leaks for the tab's
        // lifetime (and the setState calls below would fire on a dead hook).
        if (!mounted.current) { URL.revokeObjectURL(url); return; }
        if (!audioRef.current) audioRef.current = new Audio();
        const a = audioRef.current;
        revokeUrl(); // free any prior preview URL before replacing the source
        urlRef.current = url;
        a.src = url;
        a.onended = () => { revokeUrl(); setPlayingId(null); };
        await a.play();
        if (!mounted.current) { revokeUrl(); return; }
        setPlayingId(voiceId);
      } catch (e) {
        if (!mounted.current) return;
        setPlayingId(null);
        // Surface a brief "preview failed" pip WITH its cause; auto-clear so it
        // stays quiet. `a.play()` rejects with a DOMException whose message is
        // the browser's own explanation (autoplay policy) — also worth saying.
        setFailedId(voiceId);
        setFailedReason(e instanceof Error ? e.message : "preview failed");
        failTimer.current = setTimeout(() => { setFailedId(null); setFailedReason(null); }, 2600);
      } finally {
        setBusyId(null);
      }
    },
    [playingId, stop, revokeUrl],
  );

  useEffect(() => () => {
    mounted.current = false;
    audioRef.current?.pause();
    if (failTimer.current) clearTimeout(failTimer.current);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  return { preview, stop, playingId, busyId, failedId, failedReason };
}

/** Open a file picker for one emotion slot and hand the file back. */
export function pickAudio(onPick: (f: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*,video/mp4";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) onPick(f);
  };
  input.click();
}
