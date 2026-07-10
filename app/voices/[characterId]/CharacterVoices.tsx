"use client";

import Link from "next/link";
import PrototypeTabs from "@/components/ui/PrototypeTabs";
import { Eyebrow } from "@/components/ui/Primitives";
import { useCharacterVoices } from "./_variants/useCharacterVoices";
import EmotionWheel from "./_variants/EmotionWheel";
import EmotionFilmstrip from "./_variants/EmotionFilmstrip";
import EmotionRack from "./_variants/EmotionRack";

export default function CharacterVoices({ characterId }: { characterId: string }) {
  const { character, slots, coverage, total, loading, error, busySlot, addVoice, removeVoice } =
    useCharacterVoices(characterId);

  if (loading) return <p className="py-20 text-sm text-white/40">Loading character…</p>;

  if (!character) {
    return (
      <div className="py-20">
        <p className="text-sm text-white/50">{error ?? `No character “${characterId}”.`}</p>
        <Link href="/voices" className="font-jetbrains mt-4 inline-block text-[12px] text-cyan-300/80 hover:text-cyan-200">
          ← back to characters
        </Link>
      </div>
    );
  }

  const shared = { name: character.name, slots, coverage, total, busySlot, addVoice, removeVoice };

  return (
    <div className="py-10">
      <Link href="/voices" className="font-jetbrains text-[12px] text-white/40 transition hover:text-white">← characters</Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>voice overview</Eyebrow>
          <h1 className="font-instrument mt-3 text-4xl text-white">{character.name}</h1>
          <p className="mt-2 max-w-xl text-base text-white/55">
            Each <span className="text-white">Voice</span> is one emotion of this{" "}
            <span className="text-white">Character</span>. Empty slots fall back to baseline.
          </p>
        </div>
        <span className="font-jetbrains rounded-full border border-white/12 px-3 py-1 text-[11px] text-white/60">
          {character.category} · {character.lang} · {coverage}/{total} emotions
        </span>
      </div>

      {error && (
        <p className="font-jetbrains mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">
          {error}
        </p>
      )}

      <div className="mt-8">
        <PrototypeTabs
          storageKey="proto-character-voices"
          variants={[
            { id: "wheel", label: "Wheel", sub: "radial / spatial", node: <EmotionWheel {...shared} /> },
            { id: "filmstrip", label: "Filmstrip", sub: "reel / sequence", node: <EmotionFilmstrip {...shared} /> },
            { id: "rack", label: "Rack", sub: "dense / practical", node: <EmotionRack {...shared} /> },
          ]}
        />
      </div>
    </div>
  );
}
