"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Eyebrow } from "@/components/ui/Primitives";
import { EMOTION_IDS } from "@/lib/emotions";
import { useCharacterVoices } from "./_variants/useCharacterVoices";
import EmotionRack from "./_variants/EmotionRack";
import GuidedRecorder from "./_variants/GuidedRecorder";
import ApiPanel from "./_variants/ApiPanel";

// Rack won the voice-overview round — rendered directly, no switcher.
export default function CharacterVoices({ characterId }: { characterId: string }) {
  const { character, slots, coverage, total, loading, error, busySlot, addVoice, removeVoice } =
    useCharacterVoices(characterId);
  const [recording, setRecording] = useState<string | null>(null);

  // Deep link from playground fallbacks: /voices/{id}?record=angry opens the
  // guided recorder. Read via window.location so no Suspense boundary needed.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("record");
    if (wanted && EMOTION_IDS.includes(wanted)) setRecording(wanted);
  }, []);

  // GuidedRecorder needs a throwing clone (it drives its own state machine),
  // while the rack's file-upload path keeps the hook's stateful error flow.
  const cloneForRecorder = useCallback(async (emotion: string, file: File) => {
    await addVoice(emotion, file, { rethrow: true });
  }, [addVoice]);

  if (loading) return <p className="py-20 text-sm text-white/60">Loading character…</p>;

  if (!character) {
    return (
      <div className="py-20">
        <p className="text-sm text-white/65">{error ?? `No character “${characterId}”.`}</p>
        <Link href="/voices" className="font-jetbrains mt-4 inline-block text-[12px] text-cyan-300/80 hover:text-cyan-200">
          ← back to characters
        </Link>
      </div>
    );
  }

  return (
    <div className="py-10">
      <Link href="/voices" className="font-jetbrains text-[12px] text-white/60 transition hover:text-white">← characters</Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>voice overview</Eyebrow>
          <h1 className="font-instrument mt-3 text-4xl text-white">{character.name}</h1>
          <p className="mt-2 max-w-xl text-base text-white/70">
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
        <EmotionRack
          name={character.name} slots={slots} coverage={coverage} total={total}
          busySlot={busySlot} addVoice={addVoice} removeVoice={removeVoice}
          onRecord={setRecording}
        />
      </div>

      <GuidedRecorder
        emotion={recording}
        characterName={character.name}
        filledEmotions={slots.filter((s) => s.voice).map((s) => s.emotion)}
        onClone={cloneForRecorder}
        onClose={() => setRecording(null)}
        onSwitch={setRecording}
      />

      <ApiPanel characterId={character.character_id} filledEmotions={character.emotions} />
    </div>
  );
}
