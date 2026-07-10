"use client";

import AppFrame from "@/components/ui/AppFrame";
import PrototypeTabs from "@/components/ui/PrototypeTabs";
import KeysLedger from "./_variants/KeysLedger";
import KeysVault from "./_variants/KeysVault";

export default function KeysPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <PrototypeTabs
          storageKey="proto-keys"
          variants={[
            { id: "ledger", label: "Ledger", sub: "dense / practical", node: <KeysLedger /> },
            { id: "vault", label: "Vault", sub: "ceremonial / cards", node: <KeysVault /> },
          ]}
        />
      </div>
    </AppFrame>
  );
}
