"use client";

import Link from "next/link";
import { emotionMeta } from "@/lib/emotions";
import { collisionVoice, type Character } from "../_data/characters";
import type { Collision } from "./useCharacterRosterClone";

/** The 409 that is answerable: the file is still here, so ask for another name. */
export default function CharacterCollisionPrompt({
  collision, characters, retryName, setRetryName, cloning, onFile, onDiscard,
}: {
  collision: Collision;
  characters: Character[];
  retryName: string;
  setRetryName: (name: string) => void;
  cloning: boolean;
  onFile: (f: File, opts?: { name?: string; attested?: boolean }) => Promise<void>;
  onDiscard: () => void;
}) {
  // If the 409 named a voice_id, that id is a place in the app — link it
  // instead of printing a string the user has to hunt for.
  const held = collisionVoice(collision.detail, characters);
  return (
    <div className="mt-4 rounded-lg border border-rose-400/25 bg-rose-400/5 px-4 py-3">
      <p role="alert" className="font-jetbrains text-[11px] text-rose-200">
        {collision.detail}
        {held && (
          <Link href={`/voices/${held.character.character_id}`}
            className="ml-2 underline decoration-rose-300/40 underline-offset-2 transition hover:text-rose-100">
            open {held.character.name} → {emotionMeta(held.voice.emotion).label}
          </Link>
        )}
      </p>
      <p className="font-jetbrains mt-1.5 text-[11px] text-white/60">
        Nothing was cloned. “{collision.file.name}” is still here — give it another character name.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          autoFocus value={retryName} onChange={(e) => setRetryName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && retryName.trim()) void onFile(collision.file, { name: retryName, attested: true }); }}
          placeholder={`${collision.name} 2`} aria-label="Character name"
          className="font-jetbrains w-48 rounded border border-white/15 bg-transparent px-2 py-1 text-[12px] text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
        <button
          onClick={() => void onFile(collision.file, { name: retryName, attested: true })}
          disabled={!retryName.trim() || cloning}
          className="font-jetbrains rounded border border-cyan-400/30 px-2 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-400/10 disabled:opacity-40">
          {cloning ? "cloning…" : "clone under this name"}
        </button>
        <button onClick={onDiscard} disabled={cloning}
          className="font-jetbrains text-[11px] text-white/55 transition hover:text-white disabled:opacity-40">
          discard the file
        </button>
      </div>
    </div>
  );
}
