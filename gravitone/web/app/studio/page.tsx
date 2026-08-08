"use client";

import AppFrame from "@/components/ui/AppFrame";
import PrototypeTabs from "@/components/ui/PrototypeTabs";
import CuttingRoom from "./_variants/CuttingRoom";
import ScriptDesk from "./_variants/ScriptDesk";

// Studio — round 1 of the prototype loop: two mental models for video work
// (voiceover for silent footage, re-voice for known dialogue).
export default function StudioPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <PrototypeTabs
          storageKey="proto-studio"
          variants={[
            { id: "cutting-room", label: "Cutting room", sub: "the video is the spine", node: <CuttingRoom /> },
            { id: "script-desk", label: "Script desk", sub: "the script is the spine", node: <ScriptDesk /> },
          ]}
        />
      </div>
    </AppFrame>
  );
}
