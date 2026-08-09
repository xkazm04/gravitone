"use client";

// THE COMPOSER MODEL — the words, who says them, how they are directed, and
// every operation that edits them. One module because these are the pieces that
// have to change together: a mode switch carries the text, a line removal moves
// the active row and its ref, and an emotion is a REGION placed through the one
// shared model rather than a tag any of them writes by hand.

import { useMemo, useRef, useState } from "react";
import {
  applyEmotion, DEFAULT_EXPRESSION, DEFAULT_TEXT, editPlainText, parseTags, stripTags,
  wrappedAnnouncement, type Expression, type ScriptLine,
} from "./shared";
import type { ScoreEditorHandle } from "./ScoreEditor";
import type { Character } from "@/app/voices/_data/characters";

export function usePlaygroundComposer({ characters }: { characters: Character[] }) {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [expr, setExpr] = useState<Expression>(DEFAULT_EXPRESSION);
  // Composer mode: Solo = one Character throughout (current flow); Script = a
  // multi-character performance rendered as one take via /v1/performance.
  const [mode, setMode] = useState<"solo" | "script">("solo");
  const [charId, setCharId] = useState<string>("");
  const [script, setScript] = useState<ScriptLine[]>([]);
  const [activeLine, setActiveLine] = useState(0); // emotion regions target this line
  const lineRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  // The score owns the solo selection (its text area IS the solo composer), so
  // the chips and the wheel ask it to place a region rather than editing a
  // string behind its back.
  const scoreRef = useRef<ScoreEditorHandle>(null);
  // What the last emotion/text edit did or refused to do, in a sentence. Script
  // mode only — in solo the score states it in its own live region.
  const [scriptNotice, setScriptNotice] = useState<string | null>(null);
  /** The script composer's "that worked" announcement. Separate from the amber
   *  notice above, which is advisory copy and the wrong voice for a success. */
  const [scriptApplied, setScriptApplied] = useState<string | null>(null);
  const scriptSeq = useRef(0);

  // The selection to keep VISIBLE on the line being directed. The wheel is a
  // portal dialog, so opening it blurs the line and the native highlight goes
  // with it — one range, for the active line, mirrored under the words so the
  // user can still see what they are about to wrap. Only the active line needs
  // one: `insertEmotion` acts on that line and no other.
  const [lineSel, setLineSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });

  const plain = stripTags(text);
  const estSec = Math.max(1.5, Math.round(plain.length * 0.055 * 10) / 10);
  // Script mode: the non-empty lines that will actually be synthesized.
  const scriptLines = useMemo(
    () => script.filter((l) => stripTags(l.text).trim() && l.characterId),
    [script],
  );
  const scriptChars = scriptLines.reduce((n, l) => n + stripTags(l.text).length, 0);
  // Each line's WORDS, without its direction. The composer edits this and the
  // regions ride alongside — the raw tagged string stays the stored/sent unit,
  // it is just never the thing a keystroke lands in (ScriptScore's rule:
  // "regions are DERIVED, never held").
  const scriptParsed = useMemo(() => script.map((l) => parseTags(l.text)), [script]);
  const scriptPlain = useMemo(() => scriptParsed.map((p) => p.text), [scriptParsed]);

  /**
   * Direct the current selection as `emotion` — the chips, the wheel and the
   * score's own control all land here.
   *
   * No path writes a tag literal any more. The selection is read in PLAIN-text
   * offsets (both composers show plain text; the `[tags]` are derived on the way
   * out), a REGION is placed through the one shared model, and `baseline` is the
   * eraser rather than a tag the grammar cannot carry.
   */
  function insertEmotion(emotion: string) {
    if (mode !== "script") {
      scoreRef.current?.applyEmotion(emotion);
      return;
    }
    const idx = activeLine;
    const cur = script[idx];
    if (!cur) return;
    const el = lineRefs.current[idx];
    const plainLen = parseTags(cur.text).text.length;
    const start = el?.selectionStart ?? plainLen;
    const end = el?.selectionEnd ?? plainLen;
    const { next, message } = applyEmotion(cur.text, start, end, emotion);
    setScriptNotice(message);
    if (next === null) { setScriptApplied(null); return; }
    // Solo says this in the score's own status region; this is script mode's.
    // A clearance names itself in the notice above, so only the plain success —
    // the case that used to announce nothing at all — is repeated here.
    setScriptApplied(message ? null : wrappedAnnouncement(parseTags(cur.text).text, start, end, emotion));
    updateLine(idx, { text: next });
    // The plain text is unchanged by a region edit, so the caret goes back
    // exactly where the user left it.
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start, end); });
  }

  /** A free typing edit on one script line: the regions shift, grow or are
   *  CLEARED BY NAME (shared.editPlainText) — never silently re-aimed. */
  function editLineText(idx: number, nextText: string) {
    const cur = script[idx];
    if (!cur) return;
    const { next, message } = editPlainText(cur.text, nextText);
    setScriptNotice(message);
    updateLine(idx, { text: next });
  }

  // --- Script composer helpers ---------------------------------------------
  function newLine(characterId: string, lineText = ""): ScriptLine {
    scriptSeq.current += 1;
    return { id: `line-${scriptSeq.current}`, characterId, text: lineText };
  }
  function updateLine(idx: number, patch: Partial<ScriptLine>) {
    setScript((s) => s.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLine() {
    const cid = script[script.length - 1]?.characterId || charId || characters[0]?.character_id || "";
    setScript((s) => [...s, newLine(cid)]);
  }
  function removeLine(idx: number) {
    if (script.length <= 1) return;
    setScript((s) => (s.length <= 1 ? s : s.filter((_, i) => i !== idx)));
    // Compact the ref array with the list. It never was, so after a removal the
    // refs were off by one against the rows and the LAST slot still pointed at
    // a detached textarea — emotion-tag insertion (which reads selectionStart
    // from lineRefs) put the caret in the wrong row.
    lineRefs.current.splice(idx, 1);
    // Removing a line ABOVE the active one shifts the active row down by one;
    // plain clamping (the old code) left activeLine pointing at a DIFFERENT
    // line, so emotion tags landed on a row the user wasn't editing.
    setActiveLine((a) => {
      const shifted = idx < a ? a - 1 : a;
      return Math.max(0, Math.min(shifted, script.length - 2));
    });
  }
  function moveLine(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= script.length) return;
    setScript((s) => {
      const n = [...s];
      [n[idx], n[j]] = [n[j], n[idx]];
      return n;
    });
    // Follow the active row through the swap so tags keep targeting it.
    setActiveLine((a) => (a === idx ? j : a === j ? idx : a));
  }
  /** Switch composer mode, CARRYING the composed text across.
   *
   *  Going to Script used to replace whatever was in the solo composer with a
   *  canned two-line demo — the user's own sentence, tags and all, was simply
   *  gone. The demo now only appears when there is nothing to carry. */
  function switchMode(m: "solo" | "script") {
    if (m === "script") {
      if (script.length === 0) {
        const first = charId || characters[0]?.character_id || "";
        const second = characters.find((c) => c.character_id !== first)?.character_id || first;
        setScript(text.trim()
          ? [newLine(first, text), newLine(second, "")]
          : [
              newLine(first, "Hello there."),
              newLine(second, "[excited]Great to finally meet you![/excited]"),
            ]);
        setActiveLine(0);
      }
    } else if (!text.trim()) {
      // Back to Solo with nothing in it: adopt the line being edited rather
      // than handing the user a blank page they already filled in once.
      const carried = script[activeLine]?.text || script.find((l) => l.text.trim())?.text;
      if (carried) setText(carried);
    }
    setMode(m);
  }

  return {
    text, setText, expr, setExpr, mode, setMode, charId, setCharId,
    script, setScript, activeLine, setActiveLine,
    lineRefs, scoreRef, scriptNotice, scriptApplied, lineSel, setLineSel,
    plain, estSec, scriptLines, scriptChars, scriptParsed, scriptPlain,
    insertEmotion, editLineText, updateLine, addLine, removeLine, moveLine, switchMode,
  };
}
