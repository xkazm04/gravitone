"use client";

import Link from "next/link";
import { Eyebrow } from "@/components/ui/Primitives";

/** The page's own title block — and the one sentence that has to change with
 *  the pipeline that will actually run. */
export default function VoiceNewHeader({
  sovereign, activeMode,
}: {
  sovereign: boolean;
  activeMode: "cloud" | "sovereign" | null;
}) {
  return (
    <>
      <Link href="/voices" className="font-jetbrains text-[12px] text-white/45 transition hover:text-white">← characters</Link>
      <Eyebrow>new character</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">Build from a recording.</h1>
      {/* Sovereign mode transcribes nothing, diarizes nothing and classifies
          no emotions — this sentence claimed all three unconditionally. */}
      <p className="mt-2 max-w-2xl text-base text-white/70">
        {sovereign
          ? "Drop a recording — we clean it on this machine, find the speech by level, and build the baseline Voice of your Character. Emotions are added afterwards with the guided per-emotion capture."
          : activeMode === "cloud"
          ? "Drop a recording — we transcribe & diarize it, you pick the speaker, we isolate them, detect emotions, and propose a set of emotion Voices to assign into a Character."
          : "Drop a recording — we analyse it, you pick the speaker, and we propose Voices to assign into a Character."}
      </p>
    </>
  );
}
