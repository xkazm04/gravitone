"use client";

import AppFrame from "@/components/ui/AppFrame";
import PrototypeTabs from "@/components/ui/PrototypeTabs";
import PlaygroundConsole from "./_variants/PlaygroundConsole";

// The video round. All three tabs are THE SAME console — same character rail,
// same score, same emotion wheel, same expression knobs, same take log — so
// what is being compared is only the thing under review: where the picture
// belongs in a console that already works.
export default function PlaygroundPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <PrototypeTabs
          storageKey="proto-playground-video"
          variants={[
            { id: "console", label: "Console", sub: "today, no picture", node: <PlaygroundConsole /> },
            { id: "bay", label: "Reel bay", sub: "picture inside the composer", node: <PlaygroundConsole video="bay" /> },
            { id: "marquee", label: "Marquee", sub: "picture above everything", node: <PlaygroundConsole video="marquee" /> },
          ]}
        />
      </div>
    </AppFrame>
  );
}
