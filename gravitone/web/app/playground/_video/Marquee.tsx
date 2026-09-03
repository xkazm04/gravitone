"use client";

// THE MARQUEE — the picture, above the console, in every mode. It owns no
// words: a click on it loads a line into the console's own composer, where the
// score, the emotion wheel, the A/B and the expression knobs already do
// everything words need.
//
// One picture, two verbs. NARRATE reads silent footage and writes a narration
// over it (a reel: scenes, one frame each, a line per scene). RE-VOICE replaces
// the dialogue of a video whose lines you have (a dub: slots on a clock, each
// one fitted to the room it has). They are different jobs on the backend and
// different crafts on screen, but they are the same question — what is the
// picture, and what is this Character doing to it — so they share a stage.
//
// The ribbon is drawn TO SCALE against the reel's own clock: a block's width is
// its share of the runtime, so a scene with three seconds of room LOOKS like
// three seconds of room next to one with twenty.

import { useState } from "react";
import NarrateStage from "./MarqueeNarrate";
import RevoiceStage from "./MarqueeRevoice";
import type { Reel } from "./useReel";
import type { Dub, DubLine } from "./useDub";

type Verb = "narrate" | "revoice";

export default function Marquee({ reel, dub, draft, characterName, onStage }: {
  reel: Reel;
  dub: Dub;
  /** The dub sheet being written (script mode's lines, on their clock) — the
   *  stage draws it before a run so gaps and overlaps are visible while they
   *  can still be fixed. After a run the submitted slots take over, because
   *  those are the ones the verdicts belong to. */
  draft: DubLine[];
  characterName: string | null;
  /** load these words into the console's own composer */
  onStage: (text: string) => void;
}) {
  const [verb, setVerb] = useState<Verb>("narrate");

  return (
    <div className="glass-panel rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-1">
        {(["narrate", "revoice"] as const).map((v) => (
          <button key={v} onClick={() => setVerb(v)} aria-pressed={verb === v}
            title={v === "narrate"
              ? "Silent footage — read the picture and write a narration for it"
              : "A video whose dialogue you have — replace it with these Characters"}
            className={`font-jetbrains rounded-full border px-2.5 py-0.5 text-[11px] uppercase tracking-widest transition ${
              verb === v
                ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
                : "border-transparent text-white/50 hover:text-white/80"
            }`}>
            {v === "narrate" ? "narrate" : "re-voice"}
          </button>
        ))}
      </div>
      {verb === "narrate"
        ? <NarrateStage reel={reel} characterName={characterName} onStage={onStage} />
        : <RevoiceStage dub={dub} draft={draft} onStage={onStage} />}
    </div>
  );
}
