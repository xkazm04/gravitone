"use client";

import { useState } from "react";
import type { useMounted } from "@/lib/useMounted";
import {
  patchCharacterReq, deleteCharacterReq, bulkDeleteQuestion, type Character,
} from "../_data/characters";
import { runPool } from "./characterTableHelpers";

/** The selection, and the two things it can do to every Character in it. */
export function useCharacterRosterBulk({
  characters, refresh, mounted, setCloneErr,
}: {
  characters: Character[];
  refresh: () => Promise<void>;
  mounted: ReturnType<typeof useMounted>;
  /** The roster's one action banner — the clone paths write to it too. */
  setCloneErr: (message: string | null) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTag, setBulkTag] = useState("");
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const clonedSelected = [...selected].filter((id) => characters.find((c) => c.character_id === id)?.category === "cloned");

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

  return {
    selected, setSelected, clonedSelected, toggleOne,
    bulkTag, setBulkTag, bulkNotice, bulkDeleting, applyBulkTag, bulkDelete,
  };
}
