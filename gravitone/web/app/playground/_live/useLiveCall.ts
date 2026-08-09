"use client";

// The call itself: dial, mute, hang up, and what happens to every turn that
// lands. The stage above it draws this state and adds nothing to it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioBus } from "@/components/ui/AudioBus";
import { apiJson } from "@/lib/apiFetch";
import { useMounted } from "@/lib/useMounted";
import type { Character } from "@/app/voices/_data/characters";
import { computePeaks } from "../_variants/playgroundEngine";
import { DEFAULT_EXPRESSION, type Take } from "../_variants/playgroundHelpers";
import { LiveConversation, type LiveRefusal, type LiveStatus, type LiveTurn } from "./conversation";
import { encodeWav, pcmSeconds } from "./pcm";
import { upsertRow, type Row } from "./liveTurns";

export function useLiveCall({ charId, character, agentId, onTake }: {
  charId: string;
  character: Character | undefined;
  agentId: string;
  /** Hand a finished agent turn to the takes log, exactly like a render. */
  onTake: (take: Take) => void;
}) {
  const bus = useAudioBus();
  const mounted = useMounted();

  const [status, setStatus] = useState<LiveStatus>("idle");
  const [refusal, setRefusal] = useState<LiveRefusal | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [muted, setMuted] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [rehearsing, setRehearsing] = useState(false);

  const callRef = useRef<LiveConversation | null>(null);
  const urlsRef = useRef<string[]>([]);

  const live = status === "connecting" || status === "live";

  // Teardown: a live conversation must not survive this component. Object URLs
  // minted for the in-stage players are revoked here; the TAKE's own url belongs
  // to the console, which already revokes its log on unmount.
  useEffect(() => () => {
    callRef.current?.stop();
    callRef.current = null;
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  /** A completed agent turn becomes a Take through the SAME path a render uses:
   *  wav blob → computePeaks → the console's take log. Nothing downstream
   *  (player, share, review link, code export, download) learns a new shape. */
  const bankTurn = useCallback(async (turn: LiveTurn) => {
    if (!turn.pcm || turn.pcm.length === 0) return;
    const blob = encodeWav(turn.pcm, turn.rate);
    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    const seconds = pcmSeconds(turn.pcm, turn.rate);
    // Peaks are best-effort, exactly like refinePeaks: a decode failure must
    // never cost the user the turn they just had.
    let peaks: number[] = [];
    try {
      peaks = (await computePeaks(blob)).peaks;
    } catch {
      peaks = [];
    }
    if (!mounted.current) return;
    setRows((list) => list.map((r) => (r.id === turn.id ? { ...r, url, seconds } : r)));
    onTake({
      id: `take-${turn.at}-${turn.id}`,
      text: turn.text || "(spoken turn)",
      characterId: charId,
      characterName: character?.name ?? charId,
      mode: "gravitone",
      url,
      blob,
      peaks: peaks.length ? peaks : [0.2, 0.6, 0.35, 0.8, 0.4, 0.65, 0.3],
      seconds,
      kb: Math.round(blob.size / 1024),
      // A live turn has no realtime factor, no queue wait and no per-segment
      // emotion report. Absent, not zero-dressed-as-measured: `rtf: 0` is what
      // isTimingBasis() already reads as "do not predict from this", and an
      // empty `segments` draws no ribbon rather than a fabricated one.
      rtf: 0,
      synthSeconds: 0,
      queueSeconds: 0,
      ignoredSettings: [],
      segments: [],
      expr: { ...DEFAULT_EXPRESSION },
      createdAt: Date.now(),
      // `format` is left absent — formatMeta() reads that as wav, which is
      // exactly what this blob is (at the conversation's rate, not 24 kHz).
    });
  }, [charId, character, mounted, onTake]);

  const onTurn = useCallback((turn: LiveTurn) => {
    // UPSERT, never append: an utterance can be announced as a guess and then
    // as the confirmed transcript under the SAME id, and a duplicated frame
    // carries the id it already used. Appending would print the same sentence
    // twice and reorder nothing back into place.
    setRows((list) => upsertRow(list, turn));
    // A guess is not an announcement. Reading every partial decode into the
    // live region would say the same half-sentence four times before the user
    // finished it; the confirmed transcript is what gets spoken.
    if (turn.interim) return;
    setAnnouncement(
      turn.role === "user"
        ? `You said: ${turn.text}`
        : `${character?.name ?? "The agent"} said: ${turn.text}`,
    );
    if (turn.role === "agent") void bankTurn(turn);
  }, [bankTurn, character]);

  /** Open a call. `override` is the agent config for THIS conversation only. */
  const dial = useCallback(async (override: Record<string, unknown>) => {
    if (live || !agentId) return;
    setRefusal(null);
    const call = new LiveConversation(
      {
        onStatus: (s) => { if (mounted.current) setStatus(s); },
        onRefusal: (r) => { if (mounted.current) setRefusal(r); },
        onTurn,
        onInterruption: () => {
          if (mounted.current) setAnnouncement("You interrupted — the agent stopped.");
        },
      },
      { bus },
    );
    callRef.current = call;
    try {
      const { signed_url } = await apiJson<{ signed_url: string }>(
        `/api/convai/signed-url?agent_id=${encodeURIComponent(agentId)}`,
        { cache: "no-store" }, "the conversation could not be authorized");
      if (!mounted.current) { call.stop(); return; }
      await call.start(signed_url, override);
    } catch (e) {
      if (!mounted.current) return;
      call.stop();
      setStatus("idle");
      setRefusal({
        kind: "policy",
        message: e instanceof Error ? e.message : "the conversation could not be authorized",
      });
    }
  }, [agentId, bus, live, mounted, onTurn]);

  function hangUp() {
    callRef.current?.stop();
    callRef.current = null;
    setStatus("idle");
    setMuted(false);
    setRehearsing(false);
  }

  function toggleMute() {
    const call = callRef.current;
    if (!call) return;
    const next = !muted;
    call.setMuted(next);
    setMuted(next);
  }

  return {
    status, live, refusal, setRefusal, rows, setRows, muted, announcement,
    rehearsing, setRehearsing,
    dial, hangUp, toggleMute,
  };
}
