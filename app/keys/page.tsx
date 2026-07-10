import AppFrame from "@/components/ui/AppFrame";
import KeysLedger from "./_variants/KeysLedger";

// Ledger won the keys prototype round — rendered directly, no switcher.
export default function KeysPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <KeysLedger />
      </div>
    </AppFrame>
  );
}
