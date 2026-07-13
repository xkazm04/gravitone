"use client";

// The client take-picker — the PrototypeTabs interaction (tab strip, one
// active variant, aria-pressed) productized as a no-login approval page.
// The reviewer hears each take, picks the winner, optionally signs the
// decision. First pick is final.

import { useState } from "react";
import Link from "next/link";
import TakeCard, { type SharedTake } from "@/app/t/[id]/TakeCard";

export type Review = {
  id: string;
  title: string;
  script: string;
  take_ids: string[];
  created: string;
  takes: SharedTake[];
  pick: { take_id: string; reviewer: string; note: string; picked_at: string } | null;
};

export default function ReviewPicker({ review }: { review: Review }) {
  const [active, setActive] = useState(0);
  const [pick, setPick] = useState(review.pick);
  const [reviewer, setReviewer] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = review.takes[active];
  const decided = !!pick;
  const winnerIdx = pick ? review.takes.findIndex((t) => t.id === pick.take_id) : -1;

  async function submit() {
    if (!take || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/reviews/${review.id}/pick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ take_id: take.id, reviewer: reviewer.trim(), note: note.trim() }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.detail ?? "could not record the pick");
      setPick(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not record the pick");
    } finally { setBusy(false); }
  }

  return (
    <div className="pb-16">
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
        {decided ? "decision recorded" : "pick a take"}
      </div>
      <h1 className="font-instrument mt-2 text-4xl text-white">{review.title}</h1>
      {review.script && (
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-white/70">“{review.script}”</p>
      )}

      {decided && (
        <div className="glass-panel mt-5 rounded-2xl border-emerald-400/20 p-4">
          <p className="text-sm text-emerald-200">
            ✓ Take {winnerIdx + 1} ({review.takes[winnerIdx]?.character_name}) was chosen
            {pick!.reviewer && <> by <span className="text-white">{pick!.reviewer}</span></>}.
          </p>
          {pick!.note && <p className="mt-1 text-sm text-white/65">“{pick!.note}”</p>}
        </div>
      )}

      {/* tab strip — one take at a time, so they're judged against the same ear */}
      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Takes">
        {review.takes.map((t, i) => {
          const isWinner = decided && i === winnerIdx;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={`font-jetbrains cursor-pointer rounded-full border px-4 py-1.5 text-[12px] transition ${
                i === active
                  ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                  : "border-white/12 text-white/60 hover:text-white"
              } ${isWinner ? "ring-1 ring-emerald-400/50" : ""}`}
            >
              Take {i + 1} · {t.character_name}
              {isWinner && " ✓"}
            </button>
          );
        })}
      </div>

      {take && (
        <div className="mt-4">
          <TakeCard key={take.id} take={take} compact />
        </div>
      )}

      {error && (
        <p className="font-jetbrains mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/90">{error}</p>
      )}

      {!decided && (
        <div className="glass-panel mt-5 rounded-2xl p-5">
          <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
            choose take {active + 1}?
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Your name (optional)"
              maxLength={80}
              className="font-hanken w-52 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this one? (optional)"
              maxLength={200}
              className="font-hanken w-64 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
            <button onClick={() => void submit()} disabled={busy || !take}
              className="cta-glow cursor-pointer rounded-full bg-gradient-to-r from-cyan-300 to-cyan-200 px-5 py-2 text-[13px] font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-50">
              {busy ? "recording…" : `✓ Approve take ${active + 1}`}
            </button>
          </div>
          <p className="font-jetbrains mt-3 text-[11px] text-white/45">
            No account needed. The pick is final — a new round means a new link.
          </p>
        </div>
      )}

      <div className="mt-8 text-center">
        <Link href="/" className="font-jetbrains text-[11px] uppercase tracking-widest text-white/40 transition hover:text-cyan-200">
          voices cloned + directed with <span className="font-instrument text-[13px] normal-case tracking-normal text-white/70">Gravitone</span>
        </Link>
      </div>
    </div>
  );
}
