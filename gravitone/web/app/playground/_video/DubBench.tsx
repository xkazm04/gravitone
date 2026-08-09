"use client";

// DIRECTION B — A BENCH OF ITS OWN. Dubbing is treated as a distinct craft:
// slot-filling against someone else's clock, where the words are downstream of
// the room they have to fit. So it gets its own surface under the picture —
// one card per slot, the clock beside the words rather than buried in them,
// and the verdict from the last run sitting on the card that earned it.
//
// The console is untouched: script mode stays the multi-character composer it
// always was, and a click on a card still loads its line into the composer
// above, so a slot can be auditioned with the score and the wheel before the
// whole dub is run again.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import type { Character } from "@/app/voices/_data/characters";
import { DubControls, FitBadge, hueOf, SlotClock } from "./dubParts";
import type { Dub, DubLine } from "./useDub";

export default function DubBench({ dub, lines, onLines, characters, onStage }: {
  dub: Dub;
  lines: DubLine[];
  onLines: (next: DubLine[]) => void;
  characters: Character[];
  onStage: (text: string) => void;
}) {
  const patch = (id: string, p: Partial<DubLine>) =>
    onLines(lines.map((l) => (l.id === id ? { ...l, ...p } : l)));

  const add = () => {
    const last = lines[lines.length - 1];
    onLines([...lines, {
      id: `dub-${Date.now()}-${lines.length}`,
      characterId: last?.characterId ?? characters[0]?.character_id ?? "",
      text: "",
      start: last ? last.end + 0.5 : 0,
      end: last ? last.end + 4.5 : 4,
    }]);
  };

  return (
    <div className="glass-panel mt-5 rounded-2xl">
      <div className="font-jetbrains flex items-center justify-between border-b border-white/8 px-5 py-2.5 text-[11px] uppercase tracking-widest text-white/60">
        <span>dub sheet</span>
        <span>{lines.length} slot{lines.length === 1 ? "" : "s"}</span>
      </div>

      <div className="space-y-2 px-5 py-4">
        {lines.length === 0 && (
          <p className="font-jetbrains text-[11px] text-white/55">
            Nothing on the sheet yet. A slot is a stretch of the video and the words that
            replace what was said in it.
          </p>
        )}

        {lines.map((line, i) => {
          const fit = dub.fitFor(line.id);
          return (
            <div key={line.id}
              className="rounded-xl border border-white/10 bg-white/[0.02] p-3 transition hover:border-white/20">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-jetbrains w-4 shrink-0 text-[11px] text-white/40">{i + 1}</span>
                <span className="h-5 w-5 shrink-0 rounded-full"
                  style={{ background: `radial-gradient(circle at 30% 30%, hsl(${hueOf(line.characterId)} 90% 70%), hsl(${hueOf(line.characterId)} 80% 45%))` }} />
                <select
                  value={line.characterId}
                  onChange={(e) => patch(line.id, { characterId: e.target.value })}
                  aria-label={`Character for slot ${i + 1}`}
                  className="font-jetbrains min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[12px] text-white/85 transition focus:border-cyan-400/40 focus:outline-none"
                >
                  {characters.map((c) => (
                    <option key={c.character_id} value={c.character_id} className="bg-slate-900 text-white">
                      {c.name}
                    </option>
                  ))}
                </select>
                <SlotClock
                  start={line.start} end={line.end}
                  onChange={(p) => patch(line.id, p)}
                />
                <button onClick={() => onLines(lines.filter((l) => l.id !== line.id))}
                  aria-label={`Remove slot ${i + 1}`}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-white/12 text-[11px] text-white/60 transition hover:border-rose-400/40 hover:text-rose-200">
                  ✕
                </button>
              </div>

              <textarea
                value={line.text}
                onChange={(e) => patch(line.id, { text: e.target.value })}
                rows={2}
                placeholder="what this Character says instead"
                aria-label={`Words for slot ${i + 1}`}
                className="w-full resize-none rounded-lg border border-white/12 bg-black/30 px-3 py-2 text-base text-white/90 placeholder:text-white/35 focus:border-cyan-400/40 focus:outline-none"
              />

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <FitBadge fit={fit} />
                {fit?.rewritten_text && (
                  <span className="font-jetbrains text-[11px] text-amber-200">
                    spoken as “{fit.rewritten_text}”
                  </span>
                )}
                {fit?.emotion && (
                  <span className="font-jetbrains text-[11px] text-white/50">
                    read as {fit.emotion}
                    {fit.emotion_requested ? ` (${fit.emotion_requested} not recorded)` : ""}
                  </span>
                )}
                <button
                  onClick={() => onStage(line.text)}
                  disabled={!line.text.trim()}
                  title="Put this line in the composer above to audition it"
                  className="font-jetbrains ml-auto cursor-pointer rounded-md border border-white/12 px-2 py-0.5 text-[11px] text-white/65 transition enabled:hover:border-cyan-400/40 enabled:hover:text-cyan-200 disabled:opacity-40"
                >
                  → composer
                </button>
              </div>
              {fit?.error && <ErrorBanner className="mt-2">{fit.error}</ErrorBanner>}
            </div>
          );
        })}

        <button onClick={add}
          className="font-jetbrains w-full cursor-pointer rounded-xl border border-dashed border-white/15 py-2 text-[11px] text-white/60 transition hover:border-cyan-400/40 hover:text-cyan-200">
          + add slot
        </button>
      </div>

      <div className="border-t border-white/8 px-5 py-3">
        <DubControls dub={dub} lines={lines} />
      </div>
    </div>
  );
}
