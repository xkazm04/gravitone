"use client";

import AppFrame from "@/components/ui/AppFrame";
import PrototypeTabs from "@/components/ui/PrototypeTabs";
import VoicesGallery from "./_variants/VoicesGallery";
import VoicesTable from "./_variants/VoicesTable";
import VoicesLab from "./_variants/VoicesLab";

export default function VoicesPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <PrototypeTabs
          storageKey="proto-voices"
          variants={[
            { id: "gallery", label: "Gallery", sub: "browse / cards", node: <VoicesGallery /> },
            { id: "table", label: "Table", sub: "scale / operations", node: <VoicesTable /> },
            { id: "lab", label: "Lab", sub: "wildcard / capture+grade", node: <VoicesLab /> },
          ]}
        />
      </div>
    </AppFrame>
  );
}
