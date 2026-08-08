"use client";

import AppFrame from "@/components/ui/AppFrame";
import PrototypeTabs from "@/components/ui/PrototypeTabs";
import DirectorConsole from "./_variants/DirectorConsole";
import PlaygroundConsole from "./_variants/PlaygroundConsole";
import Storyboard from "./_variants/Storyboard";

// Round 2 of the playground loop: the Console (round-one winner) stays the
// baseline tab; two new variants fuse its TTS direction with the video side
// (scenes, frames, fit) on the voiceover backend.
export default function PlaygroundPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <PrototypeTabs
          storageKey="proto-playground-video"
          variants={[
            { id: "console", label: "Console", sub: "round-one winner", node: <PlaygroundConsole /> },
            { id: "director", label: "Director cut", sub: "one scene under the needle", node: <DirectorConsole /> },
            { id: "storyboard", label: "Storyboard", sub: "every scene on the desk", node: <Storyboard /> },
          ]}
        />
      </div>
    </AppFrame>
  );
}
