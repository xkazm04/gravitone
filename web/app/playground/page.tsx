import AppFrame from "@/components/ui/AppFrame";
import PlaygroundConsole from "./_variants/PlaygroundConsole";

// Console won the playground prototype round — rendered directly, no switcher.
export default function PlaygroundPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <PlaygroundConsole />
      </div>
    </AppFrame>
  );
}
