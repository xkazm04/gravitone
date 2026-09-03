import AppFrame from "@/components/ui/AppFrame";
import PlaygroundConsole from "./_variants/PlaygroundConsole";

// Console won the playground round; the Marquee won the video round that gave
// it a picture; the Dub sheet won the re-voice round that gave the picture a
// second verb (see ../_video). Rendered directly, no switcher.
export default function PlaygroundPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <PlaygroundConsole />
      </div>
    </AppFrame>
  );
}
