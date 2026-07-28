"use client";

// Session-durable COMPOSER. An earlier round made takes durable; the work that
// produced them still wasn't — a refresh restored the take log and wiped the
// text, the whole script, the expression knobs, the mode and the selected
// Character.
//
// Same mechanism as takes (lib/playgroundDb: one IndexedDB, one store each), so
// there is one durability story in the playground rather than two.

import { DEFAULT_EXPRESSION, type Expression, type ScriptLine } from "@/app/playground/_variants/shared";
import { COMPOSER_STORE, getRecord, openDb, runTx } from "@/lib/playgroundDb";

const KEY = "current";

export type ComposerState = {
  text: string;
  script: ScriptLine[];
  expr: Expression;
  mode: "solo" | "script";
  charId: string;
  activeLine: number;
};

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : fallback;
}

/**
 * Validate a persisted record into a ComposerState, or null if there is
 * nothing usable in it.
 *
 * Everything here came off disk and may be from an older build, a half-written
 * record, or a hand-edited store — restoring it unchecked would put the
 * composer into a state the UI cannot render (a `mode` that is neither solo nor
 * script, an expression slider off its scale, a script line with no id to key
 * on). Character ids are NOT checked here: which Characters exist is a server
 * question, answered by reconcileCharacters once the roster lands.
 */
export function sanitizeComposer(raw: unknown): ComposerState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const expr = (r.expr && typeof r.expr === "object" ? r.expr : {}) as Record<string, unknown>;
  const script = Array.isArray(r.script)
    ? r.script
        .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
        .map((l, i) => ({
          // A missing id would collide as a React key and break reordering.
          id: typeof l.id === "string" && l.id ? l.id : `line-restored-${i}`,
          characterId: typeof l.characterId === "string" ? l.characterId : "",
          text: typeof l.text === "string" ? l.text : "",
        }))
    : [];
  const state: ComposerState = {
    text: typeof r.text === "string" ? r.text : "",
    script,
    expr: {
      temperature: num(expr.temperature, DEFAULT_EXPRESSION.temperature, 0.5, 1),
      stability: num(expr.stability, DEFAULT_EXPRESSION.stability, 0, 1),
      quality: Math.round(num(expr.quality, DEFAULT_EXPRESSION.quality, 1, 5)),
    },
    mode: r.mode === "script" ? "script" : "solo",
    charId: typeof r.charId === "string" ? r.charId : "",
    activeLine: Math.round(num(r.activeLine, 0, 0, Math.max(0, script.length - 1))),
  };
  // Nothing worth restoring — don't overwrite a fresh composer with emptiness.
  if (!state.text.trim() && state.script.length === 0 && !state.charId) return null;
  return state;
}

/**
 * Point a restored composer at Characters that still EXIST.
 *
 * A persisted character id survives the Character being deleted, and a rail
 * with nothing selected (or a <select> showing a value that is not one of its
 * options) is how that turns into "Generate does nothing" or a 404 mid-render.
 * Returns the repaired state plus the ids that were dropped, so the console can
 * say what happened rather than silently substituting a different voice.
 */
export function reconcileCharacters(
  state: ComposerState,
  knownIds: string[],
  fallbackId: string,
): { state: ComposerState; dropped: string[] } {
  const known = new Set(knownIds);
  const dropped: string[] = [];
  const remap = (id: string): string => {
    if (known.has(id)) return id;
    if (id && !dropped.includes(id)) dropped.push(id);
    return fallbackId;
  };
  return {
    state: {
      ...state,
      charId: remap(state.charId),
      script: state.script.map((l) => ({ ...l, characterId: remap(l.characterId) })),
    },
    dropped,
  };
}

/** Persist the composer. THROWS when it could not be stored — the console says
 *  so rather than silently breaking the "survives a refresh" promise. */
export async function saveComposer(state: ComposerState): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    await runTx(db, COMPOSER_STORE, "readwrite", (store) => {
      store.put({ id: KEY, savedAt: Date.now(), state });
    });
  } finally {
    db?.close();
  }
}

/** Restore the composer, or null when nothing usable was stored. Throws when
 *  storage itself could not be read. */
export async function loadComposer(): Promise<ComposerState | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const rec = await getRecord<{ state: unknown }>(db, COMPOSER_STORE, KEY);
    return sanitizeComposer(rec?.state);
  } finally {
    db?.close();
  }
}

/** Forget the stored composer (nothing left worth restoring). */
export async function clearComposer(): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    await runTx(db, COMPOSER_STORE, "readwrite", (store) => store.delete(KEY));
  } catch {
    /* best-effort: the next save overwrites it anyway */
  } finally {
    db?.close();
  }
}
