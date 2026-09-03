"use client";

// Asking for a change instead of ending the conversation. The pick stays
// final; this opens the NEXT round, seeded from the approved take.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useMounted } from "@/lib/useMounted";
import { useState } from "react";
import Link from "next/link";
import { requestRevision } from "./actions";

export default function ReviewRevisionRequest({
  reviewId,
  reviewer,
  setReviewer,
}: {
  reviewId: string;
  reviewer: string;
  setReviewer: (v: string) => void;
}) {
  const [reviseNote, setReviseNote] = useState("");
  const [reviseDirection, setReviseDirection] = useState("");
  const [reviseBusy, setReviseBusy] = useState(false);
  const [reviseErr, setReviseErr] = useState<string | null>(null);
  const [nextRound, setNextRound] = useState<{ id: string; round: number } | null>(null);
  const mounted = useMounted();

  async function revise() {
    if (reviseBusy || !reviseNote.trim()) return;
    setReviseBusy(true); setReviseErr(null);
    try {
      const result = await requestRevision(reviewId, {
        note: reviseNote, reviewer, direction: reviseDirection,
      });
      // The round is MINTED whether or not this panel is still on screen — the
      // link is on the review it was opened from.
      if (!mounted.current) return;
      if (result.ok) {
        setNextRound({ id: result.reviewId, round: result.round });
        setReviseNote(""); setReviseDirection("");
      } else {
        setReviseErr(result.error);
      }
    } catch {
      // The action itself failed to reach the server (offline, deploy in
      // flight). Saying nothing would leave the button spinning on a request
      // that is never coming back.
      if (mounted.current) setReviseErr("the request did not reach the studio — nothing was sent");
    } finally {
      if (mounted.current) setReviseBusy(false);
    }
  }

  return (
    <div className="glass-panel mt-5 rounded-2xl p-5">
      {nextRound ? (
        <>
          <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
            round {nextRound.round} opened
          </div>
          <p className="mt-2 text-sm text-white/75">
            Your note is on the record and a new round is waiting, seeded from the take you
            approved. Send this link back to whoever recorded it:
          </p>
          <Link href={`/r/${nextRound.id}`}
            className="font-jetbrains mt-3 inline-block break-all rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-2 text-[12px] text-cyan-200 transition hover:bg-cyan-400/10">
            /r/{nextRound.id} →
          </Link>
        </>
      ) : (
        <>
          <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
            close, but not quite?
          </div>
          <p className="mt-2 text-sm text-white/70">
            Ask for a change. The decision above stays as it is — this opens a new round,
            starting from the take you picked.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input value={reviewer} onChange={(e) => setReviewer(e.target.value)}
              placeholder="Your name (optional)" maxLength={80}
              className="font-hanken w-52 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
            <input value={reviseNote} onChange={(e) => setReviseNote(e.target.value)}
              placeholder="What should change?" maxLength={500}
              className="font-hanken w-72 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
            <input value={reviseDirection} onChange={(e) => setReviseDirection(e.target.value)}
              placeholder="Direction, e.g. line 3: angry" maxLength={200}
              className="font-jetbrains w-60 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2 text-[13px] text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
            <button onClick={() => void revise()} disabled={reviseBusy || !reviseNote.trim()}
              className="font-jetbrains cursor-pointer rounded-full border border-cyan-400/40 bg-cyan-400/10 px-5 py-2 text-[12px] text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50">
              {reviseBusy ? "opening…" : "ask for a revision →"}
            </button>
          </div>
          {reviseErr && <ErrorBanner>{reviseErr}</ErrorBanner>}
        </>
      )}
    </div>
  );
}
