"use client";

import Link from "next/link";
import { Eyebrow } from "@/components/ui/Primitives";
import type { Character } from "@/app/voices/_data/characters";

/** Who this Character is, what it covers, and the two ways to leave the page. */
export default function CharacterHeader({ character, coverage, total }: {
  character: Character;
  coverage: number;
  total: number;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
      <div>
        <Eyebrow>voice overview</Eyebrow>
        <h1 className="font-instrument mt-4 text-4xl text-white">{character.name}</h1>
        <p className="mt-2 max-w-2xl text-base text-white/70">
          Each <span className="text-white">Voice</span> is one emotion of this{" "}
          <span className="text-white">Character</span>. Empty slots fall back to baseline.
        </p>
        {character.imported && (
          <p
            title="This Character was created by importing a portable .gravichar Character Pack"
            className="font-jetbrains mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.03] px-3 py-1 text-[11px] text-white/60"
          >
            ⇪ imported from <span className="text-white/80">{character.imported.from}</span>
            {(() => {
              const d = Date.parse(character.imported.at);
              return Number.isNaN(d) ? null : <span>· {new Date(d).toLocaleDateString()}</span>;
            })()}
          </p>
        )}
      </div>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-jetbrains rounded-full border border-white/12 px-3 py-1 text-[11px] text-white/60">
          {character.category} · {character.lang} · {coverage}/{total} emotions
        </span>
        {/* The other half of the clone loop. The studio (/voices/new) reads
            `extend` and arms "Extend existing" with THIS character, so a
            commit attaches its voices here and the completion screen sends the
            user back to this page. Only cloned characters can be extended —
            the studio's own dropdown is filtered the same way. */}
        {character.category === "cloned" && (
          <Link
            href={`/voices/new?extend=${encodeURIComponent(character.character_id)}`}
            title={`Scan a recording and add more emotion voices to ${character.name}`}
            className="font-jetbrains rounded-full border border-cyan-400/30 bg-cyan-400/5 px-3 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-400/10"
          >
            ＋ clone from a recording
          </Link>
        )}
        {character.category === "cloned" && (
          <a
            href={`/api/characters/${encodeURIComponent(character.character_id)}/pack`}
            download
            title="Download this Character as a portable .gravichar pack — import it on any Gravitone instance"
            className="font-jetbrains rounded-full border border-cyan-400/30 bg-cyan-400/5 px-3 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-400/10"
          >
            ⇓ export pack
          </a>
        )}
      </span>
    </div>
  );
}
