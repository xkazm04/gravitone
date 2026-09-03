"use client";

// The speaker's terms and the two writes they can make: a scoped grant, or a
// refusal. Both report the state a failure actually leaves behind — nothing
// granted, or nothing recorded.

import { useCallback, useState } from "react";
import { useMounted } from "@/lib/useMounted";
import { declineSignoff, grantSignoff, type SignoffScope, type VaultEntry } from "@/lib/voiceVault";

export function useSignoffSubmit({
  user, ownerUid, entry,
}: {
  user: { uid: string; email: string | null } | null;
  ownerUid: string | null;
  entry: VaultEntry | null;
}) {
  const mounted = useMounted();

  const [purpose, setPurpose] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [phraseSeconds, setPhraseSeconds] = useState<number | null>(null);
  const [skipRecording, setSkipRecording] = useState(false);
  const [submitting, setSubmitting] = useState<"grant" | "decline" | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"signed" | "declined" | null>(null);
  const [mirrorWarning, setMirrorWarning] = useState(false);

  const toggleExclusion = useCallback((x: string) => {
    setExclusions((prev) => (prev.includes(x) ? prev.filter((p) => p !== x) : [...prev, x]));
  }, []);

  const grant = useCallback(async () => {
    if (!user || !ownerUid || !entry) return;
    setSubmitting("grant");
    setSubmitErr(null);
    try {
      const scope: SignoffScope = {};
      if (purpose.trim()) scope.purpose = purpose.trim();
      if (expiresAt) scope.expiresAt = expiresAt;
      if (exclusions.length) scope.exclusions = exclusions;
      const res = await grantSignoff({
        ownerUid, entry, speaker: { uid: user.uid, email: user.email },
        scope, phraseRecorded: phraseSeconds != null,
        ...(phraseSeconds != null ? { phraseSeconds } : {}),
      });
      if (!mounted.current) return;
      setMirrorWarning(!res.mirror);
      setOutcome("signed");
    } catch (e) {
      if (!mounted.current) return;
      setSubmitErr(e instanceof Error
        ? `your sign-off was NOT recorded (${e.message}) — nothing was granted`
        : "your sign-off was NOT recorded — nothing was granted");
    } finally {
      if (mounted.current) setSubmitting(null);
    }
  }, [user, ownerUid, entry, purpose, expiresAt, exclusions, phraseSeconds, mounted]);

  const decline = useCallback(async () => {
    if (!user || !ownerUid || !entry) return;
    setSubmitting("decline");
    setSubmitErr(null);
    try {
      await declineSignoff(ownerUid, entry, { uid: user.uid, email: user.email });
      if (!mounted.current) return;
      setOutcome("declined");
    } catch (e) {
      if (!mounted.current) return;
      setSubmitErr(e instanceof Error ? `the refusal was not recorded (${e.message})` : "the refusal was not recorded");
    } finally {
      if (mounted.current) setSubmitting(null);
    }
  }, [user, ownerUid, entry, mounted]);

  return {
    purpose, setPurpose,
    expiresAt, setExpiresAt,
    exclusions, toggleExclusion,
    phraseSeconds, setPhraseSeconds,
    skipRecording, setSkipRecording,
    submitting, submitErr,
    outcome, mirrorWarning,
    grant, decline,
  };
}
