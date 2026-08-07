import AppFrame from "@/components/ui/AppFrame";
import CharacterVoices from "./CharacterVoices";

// Voice overview: one Character's emotion scale. Prototype round in flight —
// Wheel vs Filmstrip vs Rack behind the tab switcher.
export default async function CharacterPage({ params }: { params: Promise<{ characterId: string }> }) {
  const { characterId } = await params;
  return (
    <AppFrame>
      {/* Same route shape as /playground and /voices: AppFrame owns the
          max-w-6xl gutter, the route owns the page's top/bottom rhythm. */}
      <div className="py-10">
        <CharacterVoices characterId={characterId} />
      </div>
    </AppFrame>
  );
}
