"use client";

import { useEffect, useRef, useState } from "react";
import { recordVoiceOwnership } from "@/lib/voiceVault";
import type { CastJob, Created, Phase, State } from "./machine";

/**
 * The Voice Vault consent receipt for whatever this flow just created — one
 * write, once, and a warning when it did not land.
 */
export function useVaultReceipt(opts: {
  phase: Phase;
  user: { uid: string; email: string | null } | null;
  created: Created[];
  pendingCommit: State["pendingCommit"];
  cast: CastJob | null | undefined;
}) {
  const { phase, user, created, pendingCommit, cast } = opts;
  // Record Voice Vault ownership exactly once, when the commit completes.
  const recorded = useRef(false);
  const [vaultWarn, setVaultWarn] = useState(false);
  useEffect(() => {
    if (phase === "upload") { recorded.current = false; setVaultWarn(false); return; }
    if (phase !== "complete" || recorded.current) return;
    // A CAST creates several characters at once, so ownership is recorded per
    // member (each one knows its own character id and name). The single-commit
    // path below reads `pendingCommit`, which a cast never sets — without this
    // branch every cast Character would land in the roster with no consent
    // receipt in the vault at all.
    const castMade = (cast?.members ?? []).filter((m) => m.status === "done");
    if (user && castMade.length > 0) {
      recorded.current = true;
      const rows = castMade.flatMap((m) => (m.voices ?? []).map((v) => ({
        voice_id: v.voice_id,
        character_id: v.character_id ?? m.character_id ?? "",
        character_name: m.character,
        emotion: v.emotion,
      })));
      if (rows.length > 0) {
        void recordVoiceOwnership(user, rows, "ingested")
          .then((res) => { if (res.failed > 0) setVaultWarn(true); });
      }
      return;
    }
    const pending = pendingCommit;
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
  }, [phase, user, created, pendingCommit, cast]);

  return vaultWarn;
}
