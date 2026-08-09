"use client";

// ── composer durability ────────────────────────────────────────────────────
// The take log has survived a refresh since an earlier round; the WORK that
// produced it did not. Same mechanism (lib/playgroundDb), one store each.
//
// Everything that reads or writes the composer across a page load lives here:
// the landing's deep link, the restore, the debounced save, and the one place
// the selected Character is decided.

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { useMounted } from "@/lib/useMounted";
// Composer durability — the same IndexedDB mechanism the take log uses.
import { loadComposer, reconcileCharacters, saveComposer, type ComposerState } from "@/lib/composerStore";
import { DEFAULT_EXPRESSION, DEFAULT_TEXT, MAX_TEXT_CHARS, type Expression, type ScriptLine } from "./playgroundHelpers";
import type { Character } from "@/app/voices/_data/characters";

export function usePlaygroundComposerDurability({
  text, script, expr, mode, charId, activeLine,
  setText, setScript, setExpr, setMode, setCharId, setActiveLine,
  characters, preferred, mounted,
}: {
  text: string; script: ScriptLine[]; expr: Expression; mode: "solo" | "script";
  charId: string; activeLine: number;
  setText: Dispatch<SetStateAction<string>>;
  setScript: Dispatch<SetStateAction<ScriptLine[]>>;
  setExpr: Dispatch<SetStateAction<Expression>>;
  setMode: Dispatch<SetStateAction<"solo" | "script">>;
  setCharId: Dispatch<SetStateAction<string>>;
  setActiveLine: Dispatch<SetStateAction<number>>;
  characters: Character[];
  preferred: { character_id: string | null; picks: number };
  mounted: ReturnType<typeof useMounted>;
}) {
  // The landing's teaser CTA links here with ?text=… . Nothing read it, so the
  // "Type it. Hear it." button dropped the visitor into the default composer
  // line and quietly lost the sentence it had just shown them. An explicit deep
  // link outranks the stored session (see the composer restore below).
  const seeded = useRef(false);
  // Composer durability. `restored` is what came off disk waiting for the
  // roster (character ids can only be validated against the server's list);
  // `composerErr` reports a composer that is NOT being saved, and
  // `composerNotice` reports work that was restored but had to be repaired.
  const [restored, setRestored] = useState<ComposerState | null>(null);
  const [composerReady, setComposerReady] = useState(false);
  const [composerErr, setComposerErr] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const reconciled = useRef(false);

  // ?text=… from the landing's teaser, consumed once. The param is stripped
  // afterwards so a refresh restores the user's own session instead of
  // re-seeding the marketing line over it (same move as CharacterVoices'
  // ?record= handoff).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const wanted = url.searchParams.get("text");
    if (!wanted) return;
    seeded.current = true;
    setText(wanted.slice(0, MAX_TEXT_CHARS));
    url.searchParams.delete("text");
    window.history.replaceState({}, "", url.toString());
  }, [setText]);

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
        // `seeded` is checked explicitly rather than leaning on the mirror: a
        // deep link's setText may not have been rendered yet when this promise
        // settles, and the stored session would then win the race.
        const pristine = !seeded.current
          && cur.text === DEFAULT_TEXT && cur.script.length === 0
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
  }, [setText, setScript, setExpr, setMode, setActiveLine]);

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
  }, [characters, preferred, restored, setCharId, setScript]);

  return { composerErr, composerNotice, setComposerNotice };
}
