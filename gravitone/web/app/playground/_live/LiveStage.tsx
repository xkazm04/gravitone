"use client";

// ── The Living Stage: Live mode ──────────────────────────────────────────────
//
// The playground's third mode. You talk to the Character in the rail; it answers
// in that Character's cloned voice; you talk over it and it stops. Every agent
// turn lands in the takes log as a REAL take, so a rehearsal writes the script
// the composer renders.
//
// Self-contained by design (batch-2 §3): this component owns the whole live
// surface and reaches the console only through the props below, so
// PlaygroundConsole's mount is a mode toggle and one element.
//
// UX rules inherited from batch 1 and kept literally:
//  • Named refusals. "Line busy" is the service's honest answer when its session
//    cap is reached (convai.py `_CLOSE_BUSY`), not an error, and it is said in
//    those words. Same for a denied microphone and a disabled agents surface.
//  • Absent = invisible. No zeroed meters, no placeholder transcript, no fake
//    "connecting" waveform.
//  • Advisory, never blocking. The headphones notice and the scripted-brain
//    notice inform; neither disables anything.
//  • The AudioBus owns the signal. The input meter is EqBars reading --gt-level;
//    nothing here runs its own analyser.

import { useEffect, useMemo, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { EqBars } from "@/components/ui/Equalizer";
import { useStillMotion } from "@/lib/useStillMotion";
import type { Character } from "@/app/voices/_data/characters";
import { type ScriptLine, type Take } from "../_variants/playgroundHelpers";
import LiveControls from "./LiveControls";
import LiveTranscript from "./LiveTranscript";
import { floorLabel, hueFor, toScriptLines } from "./liveTurns";
import { useLiveAgents } from "./useLiveAgents";
import { useLiveCall } from "./useLiveCall";

export type LiveStageProps = {
  /** The roster the console already loaded — one rail, one truth. */
  characters: Character[];
  /** The Character selected in the console's rail: the agent's mouth. */
  charId: string;
  /** The console is rendering a take. Live and Generate compete for the same
   *  cores, so dialling is refused (with the reason) while it is true. */
  generateBusy: boolean;
  /** Hand a finished agent turn to the takes log, exactly like a render. */
  onTake: (take: Take) => void;
  /** Hand the whole rehearsal to the Script composer. */
  onScript: (lines: ScriptLine[]) => void;
  /** The Script composer's current lines — the source for "rehearse this". */
  scriptLines?: ScriptLine[];
  /** True while a call is up, so the console can gate Generate. */
  onActiveChange?: (active: boolean) => void;
  /** `prefers-reduced-motion`, when the console has already resolved it. Absent,
   *  this stage reads it itself — it is never guessed. */
  still?: boolean;
};

export default function LiveStage({
  characters, charId, generateBusy, onTake, onScript, scriptLines = [], onActiveChange,
  still: stillProp,
}: LiveStageProps) {
  const [scene, setScene] = useState("");

  const { info, infoErr, agentId, setAgentId, agent } = useLiveAgents();

  const character = useMemo(
    () => characters.find((c) => c.character_id === charId),
    [characters, charId],
  );
  // The second voice in the written script: a rehearsal is a two-hander, and the
  // person at the microphone is not a Character in the roster.
  const otherCharId = useMemo(
    () => characters.find((c) => c.character_id !== charId)?.character_id ?? charId,
    [characters, charId],
  );
  /** The Character's baseline Voice — the id the ENGINE speaks with. A character
   *  id is not a voice id (service/app.py resolves one to the other), so sending
   *  the character id as a voice override would name a voice that does not
   *  exist. */
  const voiceId = useMemo(() => {
    const voices = character?.voices ?? [];
    return voices.find((v) => v.emotion === "baseline")?.voice_id ?? voices[0]?.voice_id ?? "";
  }, [character]);

  const {
    status, live, refusal, setRefusal, rows, setRows, breaks, setBreaks,
    muted, speaking, announcement, rehearsing, setRehearsing,
    dial, redial, hangUp, toggleMute,
  } = useLiveCall({ charId, character, agentId, onTake });

  // Reduced motion, read ONCE for this surface and passed down (DESIGN.md
  // "gate the animation, never drop the element"). The console resolves its own
  // and may hand it in; LiveStage is mounted as one element with its own props
  // (batch-2 §3), so it answers for itself when it is not told.
  const stillPref = useStillMotion();
  const still = stillProp ?? stillPref;

  useEffect(() => { onActiveChange?.(live); }, [live, onActiveChange]);

  /** The agent config for a plain call: this Character's voice, plus the scene
   *  note when the agent permits a prompt override. */
  const overrideFor = (prompt?: string): Record<string, unknown> => {
    const allow = new Set(agent?.allow_overrides ?? []);
    const out: Record<string, unknown> = {};
    if (voiceId && allow.has("voice_id")) out.tts = { voice_id: voiceId };
    if (prompt && allow.has("prompt")) out.prompt = { prompt };
    return out;
  };

  /** Rehearse the Script composer's lines: the agent is instructed to perform
   *  them in order. This is the "Live works with no LLM configured" half, and it
   *  is honest about the one case it cannot serve — see `scriptedBrain` below. */
  function rehearse() {
    const lines = scriptLines.map((l) => l.text.trim()).filter(Boolean);
    if (lines.length === 0) return;
    setRehearsing(true);
    void dial({
      ...overrideFor(
        "You are performing a rehearsal. Say these lines IN ORDER, one per turn, " +
        "verbatim, and nothing else:\n" + lines.map((t, i) => `${i + 1}. ${t}`).join("\n"),
      ),
      first_message: lines[0],
    });
  }

  function handOff() {
    const lines = toScriptLines(rows, charId, otherCharId);
    if (lines.length > 0) onScript(lines);
  }

  // ── what the surface can and cannot do, said before it is tried ────────────
  const disabled = info && !info.enabled;
  const capped = !!info && info.sessions.max > 0 && info.sessions.active >= info.sessions.max;
  const scriptedBrain = info?.brain.backend === "scripted";
  const promptRefused = !!agent && !agent.allow_overrides.includes("prompt");
  const voiceRefused = !!agent && !agent.allow_overrides.includes("voice_id");
  const dialBlocked =
    disabled ? "Conversational agents are disabled on this service (CONVAI_ENABLED=0)."
    : infoErr ? infoErr
    : !agentId ? "No agent is installed on this service."
    : agent && !agent.speakable ? (agent.problem ?? "This agent has no voice this service can speak.")
    : generateBusy ? "The engine is rendering a take — a live call and a render compete for the same cores."
    : capped && !live ? "Line busy — this service is already holding as many conversations as it allows."
    : null;

  return (
    <div className="glass-panel mt-4 rounded-2xl" data-testid="live-stage">
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>

      <div className="font-jetbrains flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-2.5 text-[11px] uppercase tracking-widest text-white/60">
        <span className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-300" : "bg-white/25"}`}
            aria-hidden
          />
          live · table read
        </span>
        <span className="flex flex-wrap items-center gap-3 normal-case tracking-normal">
          {/* Measured facts only: which brain answered, and how many slots the
              service is holding. Both come from the service, not from here. */}
          {info && <span title="The dialog backend answering for this agent">brain · {info.brain.backend}</span>}
          {info && info.sessions.max > 0 && (
            <span title="Concurrent conversations this replica is holding">
              {info.sessions.active}/{info.sessions.max} lines
            </span>
          )}
        </span>
      </div>

      {infoErr && <ErrorBanner className="mx-5 mt-4">{infoErr}</ErrorBanner>}
      {refusal && (
        <ErrorBanner className="mx-5 mt-4" severity={refusal.kind === "busy" ? "warning" : "error"}>
          <span className="flex items-center justify-between gap-3">
            <span>{refusal.message}</span>
            <span className="flex shrink-0 items-center gap-3">
              {/* A dropped line is the one refusal with an action attached: the
                  call cannot be resumed, so the honest offer is a NEW one, and
                  it is the user who decides to make it. Blocked for the same
                  reasons Talk is blocked — the service may be capped now. */}
              {refusal.kind === "dropped" && (
                <button
                  onClick={redial}
                  disabled={!!dialBlocked}
                  title={dialBlocked ?? "Dial this agent again — a new conversation, with your transcript kept"}
                  className="font-jetbrains cursor-pointer rounded-lg border border-white/20 px-2.5 py-1 text-[11px] text-white/80 transition enabled:hover:border-cyan-400/40 enabled:hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  redial ▶
                </button>
              )}
              <button onClick={() => setRefusal(null)} aria-label="Dismiss"
                className="text-white/60 transition hover:text-white">✕</button>
            </span>
          </span>
        </ErrorBanner>
      )}

      <div className="space-y-4 px-5 py-4">
        <LiveControls
          info={info}
          agentId={agentId}
          setAgentId={setAgentId}
          scene={scene}
          setScene={setScene}
          promptRefused={promptRefused}
          dialBlocked={dialBlocked}
          live={live}
          muted={muted}
          scriptLines={scriptLines}
          onDial={() => void dial(overrideFor(scene.trim() || undefined))}
          onRehearse={rehearse}
          onToggleMute={toggleMute}
          onHangUp={hangUp}
        />

        {/* The one line that says who is about to speak, and the live input
            meter. The bars are the AudioBus reading the microphone — idle they
            are the shipped keyframe decoration, live they are the waveform. */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="h-6 w-6 shrink-0 rounded-full" aria-hidden
            style={{ background: `radial-gradient(circle at 30% 30%, hsl(${hueFor(charId)} 90% 70%), hsl(${hueFor(charId)} 80% 45%))` }} />
          <span className="text-sm text-white/85">{character?.name ?? "Pick a Character above"}</span>
          <span className="font-jetbrains text-[11px] text-white/55">
            {voiceRefused
              ? "this agent speaks in its own voice"
              : voiceId
                ? "answers in this Character's voice"
                : "this Character has no recorded voice yet"}
          </span>
          <div className="flex h-6 min-w-24 flex-1 items-end gap-[3px]" aria-hidden>
            <EqBars bars={20} height="100%" />
          </div>
          {/* Who has the floor — see `floorLabel`. The accent is the restrained
              tier's whole budget here: the word turns cyan (the agent's colour
              in the transcript) for exactly as long as it is speaking. */}
          <span
            className={`font-jetbrains shrink-0 text-[11px] transition-colors ${
              status === "live" && speaking ? "text-cyan-300" : "text-white/55"
            }`}
            data-testid="live-floor"
          >
            {floorLabel({ status, speaking, muted, hasRows: rows.length > 0 })}
          </span>
        </div>

        {/* Advisory, never blocking. */}
        <p className="font-jetbrains text-[11px] leading-relaxed text-white/50">
          Headphones recommended — this service has no echo cancellation, so speaker bleed can make
          the agent interrupt itself.
          {scriptedBrain && (
            <> This service&apos;s brain is <span className="text-white/70">scripted</span>: it says the
            agent&apos;s own fixed turns, so a scene note or a rehearsal script cannot change what it
            says. Configure <span className="text-white/70">CONVAI_LLM</span> for a model-backed brain.</>
          )}
          {rehearsing && !scriptedBrain && <> Rehearsing your script — the agent performs one line per turn.</>}
        </p>

        {/* the turn list — take-card visual language, growing downward */}
        {rows.length > 0 && (
          <LiveTranscript
            rows={rows}
            charId={charId}
            characterName={character?.name}
            live={live}
            still={still}
            breaks={breaks}
            onHandOff={handOff}
            onClear={() => { setRows([]); setBreaks([]); }}
          />
        )}
      </div>
    </div>
  );
}
