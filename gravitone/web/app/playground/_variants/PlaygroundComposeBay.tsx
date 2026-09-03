"use client";

// THE COMPOSE BAY — the panel words are written in, in either mode, plus the
// two exits at the bottom of it (Generate makes a take, Dub makes a film).
//
// It takes the composer MODEL as one object rather than twenty-five props: the
// mode toggle, the counter, the score, the rows, the scene and the chips are
// all views onto the same state, and threading them one at a time would only
// hide that.

import type { RefObject } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button } from "@/components/ui/Primitives";
import { OUTPUT_FORMATS, type OutputFormat } from "@/lib/audioFormats";
import { MAX_TEXT_CHARS, MAX_SCRIPT_LINES, type ComposerWarning } from "./playgroundHelpers";
import EmotionChips from "./EmotionChips";
import ScoreEditor from "./ScoreEditor";
import ScriptScore from "./ScriptScore";
import { PlaygroundScriptRows } from "./PlaygroundScriptRows";
import type { usePlaygroundComposer } from "./usePlaygroundComposer";
import type { Character } from "@/app/voices/_data/characters";
import type { Dub, DubLine } from "../_video/useDub";
import { DubControls } from "../_video/dubParts";

export function PlaygroundComposeBay({
  composer, composerRef, characters, character, scale, charName,
  liveOn, setLiveOn, onOpenWheel,
  dubState, dubSlots, dubDraft,
  format, setFormat, blocked, warnings, canGenerate, busy, liveActive,
  generate, cancelGenerate,
}: {
  composer: ReturnType<typeof usePlaygroundComposer>;
  composerRef: RefObject<HTMLDivElement | null>;
  characters: Character[];
  character: Character | undefined;
  scale: string[];
  charName: (id: string) => string;
  liveOn: boolean;
  setLiveOn: (updater: (v: boolean) => boolean) => void;
  onOpenWheel: () => void;
  dubState: Dub;
  dubSlots: Record<string, { start: number; end: number }>;
  dubDraft: DubLine[];
  format: OutputFormat;
  setFormat: (f: OutputFormat) => void;
  blocked: string | null;
  warnings: ComposerWarning[];
  canGenerate: boolean;
  busy: boolean;
  liveActive: boolean;
  generate: () => void;
  cancelGenerate: () => void;
}) {
  const {
    text, setText, expr, mode, charId, script, activeLine, setActiveLine,
    lineRefs, scoreRef, scriptNotice, lineSel, setLineSel,
    estSec, scriptLines, scriptChars, scriptParsed, scriptPlain,
    insertEmotion, editLineText, updateLine, addLine, removeLine, moveLine, switchMode,
  } = composer;

  return (
    <div ref={composerRef} className="glass-panel rounded-2xl">
      <div className="font-jetbrains flex items-center justify-between border-b border-white/8 px-5 py-2.5 text-[11px] uppercase tracking-widest text-white/60">
        <div className="flex items-center gap-1">
          {(["solo", "script"] as const).map((m) => (
            <button key={m} onClick={() => switchMode(m)} aria-pressed={mode === m}
              title={m === "solo" ? "One Character throughout" : "A multi-character performance in one take"}
              className={`rounded-full border px-2.5 py-0.5 transition ${mode === m ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200" : "border-transparent text-white/50 hover:text-white/80"}`}>
              {m}
            </button>
          ))}
          <button onClick={() => setLiveOn((v) => !v)} aria-pressed={liveOn}
            title="Talk to this Character in real time — every turn becomes a take"
            className={`rounded-full border px-2.5 py-0.5 transition ${liveOn ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200" : "border-transparent text-white/50 hover:text-white/80"}`}>
            live
          </button>
        </div>
        {/* The counter states the REAL ceiling, and turns as the text
            approaches it — the limit used to be discovered by a rejected
            render. */}
        <span className={blocked ? "text-rose-300" : (mode === "solo" && text.length > MAX_TEXT_CHARS * 0.9) ? "text-amber-200/90" : ""}>
          {mode === "script"
            ? `${scriptChars} chars · ${scriptLines.length}/${MAX_SCRIPT_LINES} line${scriptLines.length === 1 ? "" : "s"}`
            : `${text.length.toLocaleString()}/${MAX_TEXT_CHARS.toLocaleString()} chars · ~${estSec}s audio`}
        </span>
      </div>

      {/* SOLO — the score IS the composer. It shows the plain words and
          keeps the direction beside them as regions; the `[tags]` are
          derived on the way to the engine, so there is no markup here for a
          stray keystroke to break. */}
      {mode === "solo" ? (
        <div className="px-5 py-4">
          {/* The chips are handed IN rather than drawn below: they act on
              the score's selection, so they belong in the score's own
              direction panel. Script mode draws the same component itself,
              because there the selection lives on a line instead. */}
          <ScoreEditor ref={scoreRef} value={text} onChange={setText} onSubmit={generate}
            characterId={charId} expr={expr}
            available={character?.emotions ?? []} scale={scale}
            chips={<EmotionChips scale={scale} recorded={character?.emotions ?? []}
              onPick={insertEmotion} onOpenWheel={onOpenWheel} />} />
        </div>
      ) : (
        <PlaygroundScriptRows
          script={script} characters={characters}
          activeLine={activeLine} setActiveLine={setActiveLine}
          scriptPlain={scriptPlain} scriptParsed={scriptParsed}
          lineSel={lineSel} setLineSel={setLineSel} lineRefs={lineRefs}
          dubSlots={dubSlots} dubState={dubState}
          updateLine={updateLine} editLineText={editLineText}
          moveLine={moveLine} removeLine={removeLine} addLine={addLine}
          onSubmit={generate}
        />
      )}

      {/* SCRIPT — the scene, always visible. The score is the emotion
          surface, not an option hidden behind a disclosure triangle. */}
      {mode === "script" && script.length > 0 && (
        <div className="border-t border-white/8 px-5 py-3">
          <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">score — the scene as stacked lanes</span>
          <ScriptScore lines={script} activeLineId={script[activeLine]?.id} scale={scale} className="mt-3"
            onChangeLine={(id, next) => updateLine(script.findIndex((l) => l.id === id), { text: next })}
            characterName={charName}
            availableFor={(id) => characters.find((c) => c.character_id === id)?.emotions ?? []}
            onFocusLine={(_id, i) => { setActiveLine(i); lineRefs.current[i]?.focus(); }} />
        </div>
      )}

      {/* What the last chip/wheel press or typing edit did — a refusal, or
          the regions it cleared. Solo says it in the score's own live
          region; this is script mode's. */}
      {mode === "script" && scriptNotice && (
        <p aria-live="polite" className="font-jetbrains border-t border-white/8 px-5 py-2 text-[11px] leading-relaxed text-amber-200/90">
          {scriptNotice}
        </p>
      )}

      {/* SCRIPT's copy of the chip row. Solo hands the same component to
          the score, where it sits inside the one direction panel beside the
          other things that act on a selection; here the selection lives on
          whichever line has focus, so the row stays a sibling of the scene
          — the same ordering rule (words, then their lanes, then the one
          place you direct them), applied to a surface with N sets of words. */}
      {mode === "script" && (
        <div className="border-t border-white/8 px-5 py-4">
          <EmotionChips scale={scale} recorded={character?.emotions ?? []}
            onPick={insertEmotion} onOpenWheel={onOpenWheel} />
        </div>
      )}

      {/* What the tags in this composer will do, BEFORE the render. Amber:
          the take will be produced, it just will not say what its author
          meant. One banner per distinct mistake, each naming the outcome. */}
      {warnings.length > 0 && (
        <div className="border-t border-white/8 px-5 pt-3">
          {warnings.map((w) => (
            <ErrorBanner key={w.key} severity="warning" className="mb-2">{w.message}</ErrorBanner>
          ))}
        </div>
      )}

      {/* The second render target. The same script that Generate turns
          into a take, the dub turns into a film — one composer's two
          exits, which is the argument this sheet won on. */}
      {mode === "script" && (
        <div className="border-t border-white/8 px-5 py-3">
          <p className="font-jetbrains mb-2 text-[11px] uppercase tracking-widest text-white/60">
            dub — this script, into the picture above
          </p>
          <DubControls dub={dubState} lines={dubDraft} />
        </div>
      )}

      <div className="flex items-center justify-between border-t border-white/8 px-5 py-3">
        <span className={`font-jetbrains text-[11px] ${blocked ? "text-rose-300" : "text-white/60"}`}>
          {blocked
            ? blocked
            : mode === "script" ? "⌘↵ · one take from the whole script" : "⌘↵ to generate"}
        </span>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Export format"
            className="flex items-center gap-0.5 rounded-lg border border-white/12 p-0.5">
            {OUTPUT_FORMATS.map((f) => (
              <button key={f.id} onClick={() => setFormat(f.id)} title={f.hint}
                aria-pressed={format === f.id}
                className={`font-jetbrains cursor-pointer rounded-md px-2 py-1 text-[11px] transition ${
                  format === f.id ? "bg-cyan-400/15 text-cyan-200" : "text-white/55 hover:text-white/85"
                }`}>
                {f.label}
              </button>
            ))}
          </div>
          {busy && (
            <button
              onClick={cancelGenerate}
              className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-rose-400/40 hover:text-rose-200"
            >
              cancel
            </button>
          )}
          <Button onClick={generate} disabled={busy || liveActive || !canGenerate}
            title={blocked ?? (canGenerate ? "Render this take" : "Write something to render")}>
            {busy ? "Rendering…" : "Generate ▶"}
          </Button>
        </div>
      </div>
    </div>
  );
}
