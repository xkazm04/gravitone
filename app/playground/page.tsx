"use client";

import AppFrame from "@/components/ui/AppFrame";
import PrototypeTabs from "@/components/ui/PrototypeTabs";
import PlaygroundConsole from "./_variants/PlaygroundConsole";
import PlaygroundStage from "./_variants/PlaygroundStage";

export default function PlaygroundPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <PrototypeTabs
          storageKey="proto-playground"
          variants={[
            { id: "console", label: "Console", sub: "operator / terminal", node: <PlaygroundConsole /> },
            { id: "stage", label: "Stage", sub: "performer / cinematic", node: <PlaygroundStage /> },
          ]}
        />
      </div>
    </AppFrame>
  );
}
