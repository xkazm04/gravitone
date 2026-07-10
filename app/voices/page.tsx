import AppFrame from "@/components/ui/AppFrame";
import VoicesTable from "./_variants/VoicesTable";

// Table won the voices prototype round — rendered directly, no switcher.
export default function VoicesPage() {
  return (
    <AppFrame>
      <div className="py-10">
        <VoicesTable />
      </div>
    </AppFrame>
  );
}
