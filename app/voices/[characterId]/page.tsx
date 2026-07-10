import AppFrame from "@/components/ui/AppFrame";
import { Eyebrow } from "@/components/ui/Primitives";
import Link from "next/link";

// Voice overview (a Character's emotion set). Next /prototype round: two
// directional variants to visualise + play the emotion scale.
export default async function CharacterPage({ params }: { params: Promise<{ characterId: string }> }) {
  const { characterId } = await params;
  return (
    <AppFrame>
      <div className="py-16">
        <Eyebrow>voice overview</Eyebrow>
        <h1 className="font-instrument mt-4 text-4xl text-white">{characterId}</h1>
        <p className="mt-3 max-w-lg text-base text-white/55">
          The emotion scale for this Character — prototype round pending: two directional
          variants to visualise and play each emotion, and fill empty slots.
        </p>
        <Link href="/voices" className="font-jetbrains mt-6 inline-block text-[12px] text-cyan-300/80 hover:text-cyan-200">← back to characters</Link>
      </div>
    </AppFrame>
  );
}
