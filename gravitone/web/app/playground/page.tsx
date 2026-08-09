import AppFrame from "@/components/ui/AppFrame";
import PlaygroundConsole from "./_variants/PlaygroundConsole";

// Console won the playground prototype round; the Marquee won the video round
// that extended it (the picture is a stage above the console, present in every
// mode — see ../_video). Rendered directly, no switcher.
export default function PlaygroundPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <PlaygroundConsole />
      </div>
    </AppFrame>
  );
}
