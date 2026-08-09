"use client";

// SCRIPT MODE'S ROWS — one row per line: who says it, when it has to land, the
// words themselves on the same painted surface the solo score uses, and what
// the last dub did to it. Extracted whole from the console; it is one loop and
// one add-line button, and nothing outside the loop reads any of its markup.

import { MAX_SCRIPT_LINES, MAX_TEXT_CHARS, type ScoreRegion, type ScriptLine } from "./playgroundHelpers";
import ScoreText from "./ScoreText";
import type { Character } from "@/app/voices/_data/characters";
import type { Dub } from "../_video/useDub";
import { FitBadge, SlotClock } from "../_video/dubParts";

export function PlaygroundScriptRows({
  script, characters, activeLine, setActiveLine,
  scriptPlain, scriptParsed, lineSel, setLineSel, lineRefs,
  dubSlots, dubState,
  updateLine, editLineText, moveLine, removeLine, addLine, onSubmit,
}: {
  script: ScriptLine[];
  characters: Character[];
  activeLine: number;
  setActiveLine: (i: number) => void;
  scriptPlain: string[];
  scriptParsed: Array<{ text: string; regions: ScoreRegion[] }>;
  lineSel: { start: number; end: number };
  setLineSel: (sel: { start: number; end: number }) => void;
  lineRefs: { current: Array<HTMLTextAreaElement | null> };
  dubSlots: Record<string, { start: number; end: number }>;
  dubState: Dub;
  updateLine: (idx: number, patch: Partial<ScriptLine>) => void;
  editLineText: (idx: number, next: string) => void;
  moveLine: (idx: number, dir: -1 | 1) => void;
  removeLine: (idx: number) => void;
  addLine: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-2 px-5 py-4">
      {script.map((line, i) => (
        <div key={line.id}
          className={`rounded-xl border p-3 transition ${activeLine === i ? "border-cyan-400/25 bg-cyan-400/[0.03]" : "border-white/10 bg-white/[0.02]"}`}>
          <div className="mb-2 flex items-center gap-2">
            <span className="font-jetbrains w-4 shrink-0 text-[11px] text-white/40">{i + 1}</span>
            <span className="h-5 w-5 shrink-0 rounded-full" style={{ background: `radial-gradient(circle at 30% 30%, hsl(${(line.characterId.length * 47) % 360} 90% 70%), hsl(${(line.characterId.length * 47) % 360} 80% 45%))` }} />
            <select value={line.characterId} onFocus={() => setActiveLine(i)}
              onChange={(e) => updateLine(i, { characterId: e.target.value })}
              aria-label={`Character for line ${i + 1}`}
              className="font-jetbrains min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 transition focus:border-cyan-400/40 focus:outline-none">
              {characters.map((c) => (
                <option key={c.character_id} value={c.character_id} className="bg-slate-900 text-white">{c.name}</option>
              ))}
            </select>
            {/* The clock the line has to fit, in the row that holds
                the line. This is the dub sheet's whole claim, and its
                whole cost: a script line is also a slot, on every
                script, whether or not it is being dubbed. */}
            <SlotClock
              start={dubSlots[line.id]?.start ?? 0}
              end={dubSlots[line.id]?.end ?? 0}
              onChange={(p) => dubState.patchTiming(line.id, p)}
              compact
            />
            <div className="flex shrink-0 items-center gap-1">
              <button onClick={() => moveLine(i, -1)} disabled={i === 0} aria-label="Move line up"
                className="grid h-6 w-6 place-items-center rounded-md border border-white/12 text-[11px] text-white/60 transition enabled:hover:bg-white/5 disabled:opacity-25">↑</button>
              <button onClick={() => moveLine(i, 1)} disabled={i === script.length - 1} aria-label="Move line down"
                className="grid h-6 w-6 place-items-center rounded-md border border-white/12 text-[11px] text-white/60 transition enabled:hover:bg-white/5 disabled:opacity-25">↓</button>
              <button onClick={() => removeLine(i)} disabled={script.length <= 1} aria-label="Remove line"
                className="grid h-6 w-6 place-items-center rounded-md border border-white/12 text-[11px] text-white/60 transition enabled:hover:border-rose-400/40 enabled:hover:text-rose-200 disabled:opacity-25">✕</button>
            </div>
          </div>
          {/* Same painted surface as the solo composer: the direction on
              this line is visible IN the line, not only in the lane
              under the scene. */}
          <ScoreText
            text={scriptPlain[i] ?? ""}
            regions={scriptParsed[i]?.regions ?? []}
            selection={activeLine === i ? lineSel : null}
            textareaRef={(el) => { lineRefs.current[i] = el; }}
            onFocus={() => setActiveLine(i)}
            onChangeText={(next) => editLineText(i, next)}
            onSelectionChange={setLineSel}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmit(); }}
            rows={2}
            invalid={line.text.length > MAX_TEXT_CHARS}
            label={`Line ${i + 1} text`}
            className="!border-transparent !bg-transparent"
            placeholder="Line text… select words and pick an emotion to switch this Character's Voices" />
          {line.text.length > MAX_TEXT_CHARS && (
            <p className="font-jetbrains mt-1 text-[11px] text-rose-300">
              {line.text.length.toLocaleString()}/{MAX_TEXT_CHARS.toLocaleString()} characters — this line is too long to render.
            </p>
          )}
          {/* …and what the last dub did to it, on the line it was done
              to. A verdict is only shown for a line that was actually
              sent: editing after a run must not make a badge describe
              words that never produced it. */}
          {dubState.fitFor(line.id) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <FitBadge fit={dubState.fitFor(line.id)} />
              {dubState.fitFor(line.id)?.rewritten_text && (
                <span className="font-jetbrains text-[11px] text-amber-200">
                  spoken as “{dubState.fitFor(line.id)?.rewritten_text}”
                </span>
              )}
              {dubState.fitFor(line.id)?.emotion && (
                <span className="font-jetbrains text-[11px] text-white/50">
                  read as {dubState.fitFor(line.id)?.emotion}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
      <button onClick={addLine} disabled={script.length >= MAX_SCRIPT_LINES}
        title={script.length >= MAX_SCRIPT_LINES
          ? `A performance renders at most ${MAX_SCRIPT_LINES} lines in one call`
          : "Add a line to the script"}
        className="font-jetbrains w-full rounded-xl border border-dashed border-white/15 py-2 text-[11px] text-white/60 transition enabled:hover:border-cyan-400/40 enabled:hover:text-cyan-200 disabled:opacity-40">
        {script.length >= MAX_SCRIPT_LINES ? `line limit reached (${MAX_SCRIPT_LINES})` : "+ add line"}
      </button>
    </div>
  );
}
