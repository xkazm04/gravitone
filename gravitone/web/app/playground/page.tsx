"use client";

import AppFrame from "@/components/ui/AppFrame";
import PrototypeTabs from "@/components/ui/PrototypeTabs";
import PlaygroundConsole from "./_variants/PlaygroundConsole";

// The RE-VOICE round. All three tabs are the same console with the same
// marquee above it; the picture's second verb (replace this video's dialogue)
// is in every one of them. What differs is only where a dub's LINES live —
// reused from script mode, or on a bench of their own.
export default function PlaygroundPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <PrototypeTabs
          storageKey="proto-playground-dub"
          variants={[
            { id: "console", label: "Console", sub: "today, narrate only", node: <PlaygroundConsole /> },
            { id: "script", label: "Dub sheet", sub: "script mode grows a clock", node: <PlaygroundConsole dub="script" /> },
            { id: "bench", label: "Dub bench", sub: "a surface of its own", node: <PlaygroundConsole dub="bench" /> },
          ]}
        />
      </div>
    </AppFrame>
  );
}
