// Embeddable Voice Card — iframe-sized, no page chrome. The brand aesthetic
// travels wherever the audio does.
import { notFound } from "next/navigation";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { loadTake } from "@/lib/takes";
import TakeCard from "../TakeCard";

export const metadata = { robots: { index: false } };

export default async function TakeEmbedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await loadTake(id);
  // Missing / evicted is a 404. An unreachable backend is NOT: this card is
  // embedded in someone else's page, and collapsing a restart into "not found"
  // told every host their embed had been deleted.
  if (loaded.status === "gone") notFound();
  if (loaded.status === "unreachable") {
    return (
      <div className="font-hanken min-h-screen bg-[#080a10] p-3 text-slate-200">
        <ErrorBanner severity="error" className="m-0">
          {loaded.detail} — this take could not be loaded right now. It has not been removed.
        </ErrorBanner>
      </div>
    );
  }

  return (
    <div className="font-hanken min-h-screen bg-[#080a10] p-3 text-slate-200">
      <TakeCard take={loaded.take} compact />
    </div>
  );
}
