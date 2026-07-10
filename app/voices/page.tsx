import AppFrame from "@/components/ui/AppFrame";
import CharacterTable from "./_variants/CharacterTable";

// Table won the voices round; it now sits at the Character layer (the roster).
// Drill-down to a Character's emotion Voices lives at /voices/[characterId].
export default function VoicesPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <CharacterTable />
      </div>
    </AppFrame>
  );
}
