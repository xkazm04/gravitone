"use client";

import { useState } from "react";
import { ApiError, readDetail } from "@/lib/apiFetch";
import { CONSENT_PROMPT, recordVoiceOwnership } from "@/lib/voiceVault";
import type { Voice } from "../_data/characters";

/** A quick clone that 409'd on a taken id, with the file still in hand. */
export type Collision = { file: File; name: string; detail: string };

/**
 * The two ways a Character enters the roster from this page: one dropped
 * recording, or one portable pack — and the collision each of them can hit.
 */
export function useCharacterRosterClone({
  user, createVoice, refresh, setCloneErr,
}: {
  user: { uid: string; email: string | null } | null;
  createVoice: (file: Blob, character: string, emotion: string, tags?: string[], filename?: string) => Promise<Voice>;
  refresh: () => Promise<void>;
  /** The roster's one action banner — bulk tag and bulk delete write to it too. */
  setCloneErr: (message: string | null) => void;
}) {
  const [cloning, setCloning] = useState(false);
  // A quick clone that 409'd on a taken id. The FILE is kept: the id is taken,
  // the recording is fine, and discarding it made the user re-pick the file to
  // answer a question we could have asked with it still in hand.
  const [collision, setCollision] = useState<Collision | null>(null);
  const [retryName, setRetryName] = useState("");
  const [vaultWarn, setVaultWarn] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

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

  return {
    cloning, collision, setCollision, retryName, setRetryName, vaultWarn, importing, onFile, onPack,
  };
}
