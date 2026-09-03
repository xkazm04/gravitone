"use client";

// The sign-off badge, shared by both sides of the vault: the owner's list of
// voices they cloned, and the speaker's list of voices cloned from them.

import { type SignoffBadge } from "@/lib/voiceVault";

const BADGE_CLASS: Record<SignoffBadge["tone"], string> = {
  strong: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  pending: "border-white/15 bg-white/5 text-white/60",
  alert: "border-amber-400/40 bg-amber-400/10 text-amber-200",
};

export function SignoffBadgePill({ badge }: { badge: SignoffBadge | null }) {
  // Absent = invisible: a self-attested voice carries no badge at all, so the
  // speaker-signed one stays the strongest thing on the row.
  if (!badge) return null;
  return (
    <span className={`font-jetbrains shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${BADGE_CLASS[badge.tone]}`}>
      {badge.label}
    </span>
  );
}
