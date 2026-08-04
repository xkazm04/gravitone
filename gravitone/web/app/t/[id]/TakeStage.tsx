"use client";

// The share page's player, as one thing.
//
// The card and the score are two views of ONE clip, and they used to be two
// unrelated widgets stacked on a page: the card owned an <audio> nobody else
// could see, the score drew a timeline nothing could move, and both of them
// listed the same segments — the ribbon in order, the score in time. The stage
// owns the transport, hands it to both, and decides which of the two segment
// surfaces the page actually shows.
//
// The rule for that duplicate: the SCORE is the primary surface, because it
// shows the shape of the performance and not merely its order. The ribbon
// survives as the fallback for takes the score cannot draw at all (no segments,
// or no duration to place them on), and on the embed, where there is no room
// for a score.

import { useState } from "react";
import TakeCard from "./TakeCard";
import TakeScore, { hasScore } from "./TakeScore";
import { useTakeTransport } from "./useTakeTransport";
import type { SharedTake } from "@/lib/takes";

export default function TakeStage({ take }: { take: SharedTake }) {
  const transport = useTakeTransport(take.id, 64);
  // The take never changes identity on this page, so the score's presence is
  // fixed for the life of the mount — computed once rather than per render.
  const [scored] = useState(() => hasScore(take));

  return (
    <>
      <div className="pt-8">
        <TakeCard take={take} transport={transport} ribbon={!scored} />
      </div>
      <TakeScore take={take} transport={transport} />
    </>
  );
}
