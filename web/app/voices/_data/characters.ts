"use client";

// ── ONE data layer for Character & Voice management ───────────────────────────
// The roster page (/voices) and the detail page (/voices/[id]) both consume this
// module. It owns every fetch/CRUD/preview against the /api/characters and
// /api/voices proxies, so the two pages can never drift apart again (they used
// to keep two parallel copies of the clone/delete logic). Mutations surface
// their failures to callers; nothing is swallowed.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson, throwDetail } from "@/lib/apiFetch";
import { CONSENT_STATEMENT } from "@/lib/consent";
import { useMounted } from "@/lib/useMounted";
import { EMOTIONS, emotionMeta, isBaseEmotion } from "@/lib/emotions";
import { useAuth } from "@/lib/useAuth";
import { recordVoiceOwnership, type ConsentMethod } from "@/lib/voiceVault";

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
    ).finally(() => { if (current === req) current = null; });
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
  return (await r.json()) as Character;
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
  return (await r.json()) as Voice;
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

  const patchCharacter = useCallback(async (id: string, patch: { name?: string; tags?: string[] }) => {
    setCharacters((cs) => cs.map((c) => (c.character_id === id ? { ...c, ...patch } : c))); // optimistic
    try {
      const updated = await patchCharacterReq(id, patch);
      // Re-sync from the server so normalized values (lowercased tags, trimmed
      // name) replace the optimistic guess.
      setCharacters((cs) => cs.map((c) => (c.character_id === id ? updated : c)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed");
      await refresh(); // roll the optimistic edit back to server truth
    }
  }, [refresh]);

  const deleteCharacter = useCallback(async (id: string) => {
    setCharacters((cs) => cs.filter((c) => c.character_id !== id)); // optimistic
    try {
      await deleteCharacterReq(id);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
      await refresh(); // restore the row we optimistically removed
    }
  }, [refresh]);

  return { characters, loading, error, readFailed, refresh, createVoice, patchCharacter, deleteCharacter };
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

  const removeVoice = useCallback(
    async (voiceId: string) => {
      setError(null);
      try {
        await deleteVoiceReq(voiceId);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "delete failed");
      }
    },
    [refresh],
  );

  const coverage = slots.filter((s) => s.voice).length;

  return { character, slots, coverage, total: slots.length, loading, error, notFound, busySlot,
           vaultWarning, addVoice, removeVoice, addCustomEmotion,
           removeCustomEmotion, refresh };
}

// ── preview hook ────────────────────────────────────────────────────────────
/** Synthesize a short line with one Voice and play it. One preview at a time.
 *  A failed preview surfaces briefly as `failedId` (no longer swallowed). */
export function useVoicePreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null); // current preview blob URL, so it can be revoked
  const failTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

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
      if (failTimer.current) clearTimeout(failTimer.current);
      setBusyId(voiceId);
      try {
        const text = line ?? `Hi, this is ${label}. This is how I sound.`;
        const r = await fetch("/api/tts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voiceId }),
        });
        if (!r.ok) throw new Error("preview failed");
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
      } catch {
        if (!mounted.current) return;
        setPlayingId(null);
        // Surface a brief "preview failed" pip; auto-clear so it stays quiet.
        setFailedId(voiceId);
        failTimer.current = setTimeout(() => setFailedId(null), 2600);
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

  return { preview, stop, playingId, busyId, failedId };
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
