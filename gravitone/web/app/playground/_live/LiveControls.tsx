"use client";

// The dialling row: who you are calling, what the call is about, and the one
// button that opens it. It disables nothing on its own — `dialBlocked` is the
// stage's already-derived sentence, and it is both the reason and the title.

import { Button } from "@/components/ui/Primitives";
import type { ScriptLine } from "../_variants/playgroundHelpers";
import type { AgentsInfo } from "./useLiveAgents";

export default function LiveControls({
  info, agentId, setAgentId, scene, setScene, promptRefused, dialBlocked,
  live, muted, scriptLines, onDial, onRehearse, onToggleMute, onHangUp,
}: {
  info: AgentsInfo | null;
  agentId: string;
  setAgentId: (id: string) => void;
  scene: string;
  setScene: (s: string) => void;
  promptRefused: boolean;
  /** Why Talk is refused, in the words the user gets — null when it is not. */
  dialBlocked: string | null;
  live: boolean;
  muted: boolean;
  scriptLines: ScriptLine[];
  onDial: () => void;
  onRehearse: () => void;
  onToggleMute: () => void;
  onHangUp: () => void;
}) {
  return (
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
              onClick={onToggleMute}
              aria-pressed={muted}
              title={muted ? "Unmute your microphone" : "Mute your microphone (the call stays up)"}
              className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/75 transition hover:border-cyan-400/40 hover:text-cyan-200"
            >
              {muted ? "unmute" : "mute"}
            </button>
            <button
              onClick={onHangUp}
              className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/75 transition hover:border-rose-400/40 hover:text-rose-200"
            >
              hang up
            </button>
          </>
        ) : (
          <>
            {scriptLines.some((l) => l.text.trim()) && (
              <button
                onClick={onRehearse}
                disabled={!!dialBlocked}
                title="Dial this agent and have it perform the Script composer's lines"
                className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/75 transition enabled:hover:border-cyan-400/40 enabled:hover:text-cyan-200 disabled:opacity-40"
              >
                ◎ rehearse this script
              </button>
            )}
            <Button
              onClick={onDial}
              disabled={!!dialBlocked}
              title={dialBlocked ?? "Open a live conversation with this Character's voice"}
            >
              Talk ▶
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
