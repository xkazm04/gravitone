import AppFrame from "@/components/ui/AppFrame";
import CharacterVoices from "./CharacterVoices";

// Voice overview: one Character's emotion scale. Prototype round in flight —
// Wheel vs Filmstrip vs Rack behind the tab switcher.
export default async function CharacterPage({ params }: { params: Promise<{ characterId: string }> }) {
  const { characterId } = await params;
  return (
    <AppFrame>
      <CharacterVoices characterId={characterId} />
    </AppFrame>
  );
}
