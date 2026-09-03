"use client";

/*
 * SELECTION SWEEP — the casting board's one Signal accent.
 *
 * RESTRAINED TIER. The casting board is a working surface: the per-speaker play
 * buttons, the durations, the utterance counts and the sample text are all
 * untouched, because a tool a user operates must not perform. What changes when
 * a speaker is TICKED is a state, and a state is where this language is allowed
 * to speak — so the selected row gets one hairline drawn along its base, in the
 * accent, once.
 *
 * ENTRANCE-ONLY by construction: the element only exists while the row is
 * selected, so it draws on selection and simply is not there when it is not.
 * Nothing loops, and nothing re-runs on the re-renders a name being typed into
 * the row causes — the <Draw> keeps its own initial/animate across those.
 *
 * The parent row must be `relative`; this fills its bottom edge and is
 * pointer-transparent so it can never eat a click meant for the row.
 */

import { Draw, accentVar } from "@/components/variants/features/previews/illus";
import { useStillMotion } from "@/lib/useStillMotion";

export default function SelectionSweep() {
  const still = useStillMotion();
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 2"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] w-full"
    >
      <Draw
        d="M0 1 H100"
        duration={0.55}
        stroke={accentVar("cyan")}
        width={2}
        opacity={0.85}
        still={still}
      />
    </svg>
  );
}
