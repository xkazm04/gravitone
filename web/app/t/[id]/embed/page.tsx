// Embeddable Voice Card — iframe-sized, no page chrome. The brand aesthetic
// travels wherever the audio does.
import { notFound } from "next/navigation";
import { loadTake } from "@/lib/takes";
import TakeCard from "../TakeCard";

export const metadata = { robots: { index: false } };

export default async function TakeEmbedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const take = await loadTake(id); // missing / evicted / backend away -> 404
  if (!take) notFound();

  return (
    <div className="font-hanken min-h-screen bg-[#080a10] p-3 text-slate-200">
      <TakeCard take={take} compact />
    </div>
  );
}
