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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button } from "@/components/ui/Primitives";
import { EqBars } from "@/components/ui/Equalizer";
import TakePlayer from "@/components/ui/TakePlayer";
import { useAudioBus } from "@/components/ui/AudioBus";
import { EASE } from "@/components/ui/tokens";
import { apiJson } from "@/lib/apiFetch";
import { useMounted } from "@/lib/useMounted";
import type { Character } from "@/app/voices/_data/characters";
import { computePeaks } from "../_variants/engine";
import { DEFAULT_EXPRESSION, type ScriptLine, type Take } from "../_variants/shared";
import { LiveConversation, type LiveRefusal, type LiveStatus, type LiveTurn } from "./conversation";
import { encodeWav, pcmSeconds } from "./pcm";

/** What the service says about its own conversational surface. */
type AgentsInfo = {
  agents: Array<{
    agent_id: string;
    name: string;
    language: string;
    first_message: string;
    scripted_turns: number;
    allow_overrides: string[];
    speakable: boolean;
    problem?: string;
    voice_id?: string | null;
  }>;
  brain: { backend: string; model?: string };
  enabled: boolean;
  sessions: { active: number; max: number };
};

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
};

const hueFor = (id: string) => (id.length * 47) % 360;

type Row = LiveTurn & { url?: string; seconds?: number };

export default function LiveStage({
  characters, charId, generateBusy, onTake, onScript, scriptLines = [], onActiveChange,
}: LiveStageProps) {
  const bus = useAudioBus();
  const mounted = useMounted();

  const [info, setInfo] = useState<AgentsInfo | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [scene, setScene] = useState("");
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [refusal, setRefusal] = useState<LiveRefusal | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [muted, setMuted] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [rehearsing, setRehearsing] = useState(false);

  const callRef = useRef<LiveConversation | null>(null);
  const urlsRef = useRef<string[]>([]);

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

  const agent = info?.agents.find((a) => a.agent_id === agentId);
  const live = status === "connecting" || status === "live";

  useEffect(() => { onActiveChange?.(live); }, [live, onActiveChange]);

  // What the service can actually do, read once. A failure here is reported —
  // "no agents" and "we could not ask" are different sentences.
  useEffect(() => {
    const ctrl = new AbortController();
    apiJson<AgentsInfo>("/api/convai/agents", { cache: "no-store", signal: ctrl.signal },
      "the conversational surface could not be read")
      .then((j) => {
        if (ctrl.signal.aborted || !mounted.current) return;
        setInfo(j);
        setAgentId((cur) => cur || j.agents.find((a) => a.speakable)?.agent_id || j.agents[0]?.agent_id || "");
      })
      .catch((e) => {
        if (ctrl.signal.aborted || !mounted.current) return;
        setInfoErr(e instanceof Error ? e.message : "the conversational surface could not be read");
      });
    return () => ctrl.abort();
  }, [mounted]);

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
    setRows((list) => [...list, turn]);
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

  /** The agent config for a plain call: this Character's voice, plus the scene
   *  note when the agent permits a prompt override. */
  const overrideFor = useCallback((prompt?: string): Record<string, unknown> => {
    const allow = new Set(agent?.allow_overrides ?? []);
    const out: Record<string, unknown> = {};
    if (voiceId && allow.has("voice_id")) out.tts = { voice_id: voiceId };
    if (prompt && allow.has("prompt")) out.prompt = { prompt };
    return out;
  }, [agent, voiceId]);

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

  /** Hand the rehearsal to the Script composer: agent turns speak as the dialled
   *  Character, your own turns as the next Character in the roster. */
  function handOff() {
    const lines: ScriptLine[] = rows
      .filter((r) => r.text.trim())
      .map((r, i) => ({
        id: `line-live-${r.id}-${i}`,
        characterId: r.role === "agent" ? charId : otherCharId,
        text: r.text.trim(),
      }));
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
            <button onClick={() => setRefusal(null)} aria-label="Dismiss"
              className="shrink-0 text-white/60 transition hover:text-white">✕</button>
          </span>
        </ErrorBanner>
      )}

      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-40 flex-1">
            <span className="font-jetbrains mb-1 block text-[11px] uppercase tracking-widest text-white/60">agent</span>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={live || !info?.agents.length}
              aria-label="Agent"
              className="font-jetbrains w-full rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-[12px] text-white/85 transition focus:border-cyan-400/40 focus:outline-none disabled:opacity-50"
            >
              {(info?.agents ?? []).map((a) => (
                <option key={a.agent_id} value={a.agent_id} className="bg-slate-900 text-white">
                  {a.name}{a.speakable ? "" : " — no voice installed"}
                </option>
              ))}
              {!info?.agents.length && <option value="">no agent installed</option>}
            </select>
          </label>

          <label className="min-w-56 flex-[2]">
            <span className="font-jetbrains mb-1 block text-[11px] uppercase tracking-widest text-white/60">
              scene note
            </span>
            <input
              value={scene}
              onChange={(e) => setScene(e.target.value)}
              disabled={live || promptRefused}
              placeholder={promptRefused
                ? "this agent refuses prompt overrides — its own instructions apply"
                : "One line: who you are and what this call is about…"}
              aria-label="Scene note"
              className="font-jetbrains w-full rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-[12px] text-white/85 placeholder:text-white/40 transition focus:border-cyan-400/40 focus:outline-none disabled:opacity-50"
            />
          </label>

          <div className="flex items-center gap-2">
            {live ? (
              <>
                <button
                  onClick={toggleMute}
                  aria-pressed={muted}
                  title={muted ? "Unmute your microphone" : "Mute your microphone (the call stays up)"}
                  className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/75 transition hover:border-cyan-400/40 hover:text-cyan-200"
                >
                  {muted ? "unmute" : "mute"}
                </button>
                <button
                  onClick={hangUp}
                  className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/75 transition hover:border-rose-400/40 hover:text-rose-200"
                >
                  hang up
                </button>
              </>
            ) : (
              <>
                {scriptLines.some((l) => l.text.trim()) && (
                  <button
                    onClick={rehearse}
                    disabled={!!dialBlocked}
                    title="Dial this agent and have it perform the Script composer's lines"
                    className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/75 transition enabled:hover:border-cyan-400/40 enabled:hover:text-cyan-200 disabled:opacity-40"
                  >
                    ◎ rehearse this script
                  </button>
                )}
                <Button
                  onClick={() => void dial(overrideFor(scene.trim() || undefined))}
                  disabled={!!dialBlocked}
                  title={dialBlocked ?? "Open a live conversation with this Character's voice"}
                >
                  Talk ▶
                </Button>
              </>
            )}
          </div>
        </div>

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
          <span className="font-jetbrains shrink-0 text-[11px] text-white/55">
            {status === "connecting" ? "connecting…"
              : status === "live" ? (muted ? "muted" : "listening")
              : rows.length > 0 ? "call ended" : ""}
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
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {rows.map((r) => (
                <motion.div key={r.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
                  <div className="font-jetbrains flex flex-wrap items-center gap-3 text-[11px] text-white/60">
                    <span className={r.role === "agent" ? "text-cyan-300" : "text-white/80"}>
                      {r.role === "agent" ? (character?.name ?? "agent") : "you"}
                    </span>
                    {r.seconds ? <span>{r.seconds}s</span> : null}
                    {r.interrupted && (
                      <span className="rounded-full border border-amber-400/25 bg-amber-400/5 px-2 py-0.5 text-amber-200/85"
                        title="You talked over this turn — the take holds the whole reply, but only part of it was heard">
                        interrupted
                      </span>
                    )}
                    {r.role === "agent" && r.url && <span className="text-white/45">↓ in the takes log</span>}
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-white/85">{r.text}</p>
                  {r.url && (
                    <TakePlayer src={r.url} compact hue={hueFor(charId)} className="mt-2 max-w-[280px]"
                      label={`${character?.name ?? "agent"} turn`} />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handOff}
                title="Turn this conversation into script lines in the composer"
                className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/75 transition hover:border-cyan-400/40 hover:text-cyan-200"
              >
                → send to Script composer
              </button>
              <button
                onClick={() => setRows([])}
                disabled={live}
                title="Clear this transcript (your takes stay in the log)"
                className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/60 transition enabled:hover:border-white/35 disabled:opacity-40"
              >
                clear
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
