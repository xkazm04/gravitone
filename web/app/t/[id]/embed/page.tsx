// Embeddable Voice Card — iframe-sized, no page chrome. The brand aesthetic
// travels wherever the audio does.
import { notFound } from "next/navigation";
import { backendFetch } from "@/lib/backend";
import TakeCard, { type SharedTake } from "../TakeCard";

export const metadata = { robots: { index: false } };

export default async function TakeEmbedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let take: SharedTake | null = null;
  try {
    const r = await backendFetch(`/v1/takes/${encodeURIComponent(id)}`, { cache: "no-store" });
    take = r.ok ? ((await r.json()) as SharedTake) : null;
  } catch { /* unreachable backend → 404 */ }
  if (!take) notFound();

  return (
    <div className="font-hanken min-h-screen bg-[#080a10] p-3 text-slate-200">
      <TakeCard take={take} compact />
    </div>
  );
}
