"use client";

import { Button } from "@/components/ui/Primitives";
import { MAX_CAST_MEMBERS, type CastMemberReq } from "../_state/cast";
import type { Pending } from "../_state/useIngestActions";

/** The cast kickoff panel. */
export default function VoiceNewCastPanel({
  picked, consented, setConsented, consentStatement, externalSource,
  castRefused, pending, startCast,
}: {
  picked: CastMemberReq[];
  consented: boolean;
  setConsented: (v: boolean) => void;
  consentStatement: string;
  externalSource: boolean;
  castRefused: string | null;
  pending: Pending;
  startCast: () => void;
}) {
  return (
    <div className="glass-panel mt-5 rounded-2xl p-5">
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
        cast {picked.length} character{picked.length === 1 ? "" : "s"} · one scan
      </div>
      <p className="mt-2 max-w-2xl text-sm text-white/65">
        Each ticked speaker is labelled and cloned from the audio this scan already
        produced — no second transcription, no second isolation, one job. A cast
        clones every emotion that clears the length minimum and skips the review
        ledger; if one speaker can&apos;t be cast, the others still are, and this
        screen will say which.
      </p>
      <p className="font-jetbrains mt-2 max-w-2xl text-[11px] leading-relaxed text-white/40">
        Up to {MAX_CAST_MEMBERS} at a time. The recording itself is not kept for a
        cast — clone a single speaker if you want its audio stored on this box.
      </p>
      <label className="mt-4 flex cursor-pointer items-start gap-2 text-[13px] text-white/70">
        <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)}
          className="mt-0.5 accent-cyan-300" />
        <span>
          {consentStatement}{" "}
          <span className="font-jetbrains text-[11px] text-white/45">
            (one attestation covers this cast — it is stored with every Character it
            creates{externalSource ? ", together with the link it came from" : ""})
          </span>
        </span>
      </label>
      {castRefused && (
        <p className="font-jetbrains mt-3 text-[11px] text-amber-200/80">{castRefused}</p>
      )}
      <Button onClick={startCast}
        disabled={pending !== null || !consented || castRefused !== null}
        className="mt-4 cursor-pointer">
        {pending === "cast" ? "Starting the cast…" : `Cast ${picked.length} character${picked.length === 1 ? "" : "s"} →`}
      </Button>
    </div>
  );
}
