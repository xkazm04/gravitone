"use client";

// The expanded transport: everything the pill turns into. Purely
// presentational — every number and every sentence on it is computed by <Dock>
// and handed down, so the panel cannot disagree with the state machine about
// what is happening.

import type { Dispatch, ReactNode, RefObject } from "react";

import type { NarrationStep } from "@/lib/narratable";
import { EqBars } from "./Equalizer";
import { AUTO_NARRATOR, type Narrator } from "./narrationDockNarrator";
import type { DockEvent, DockState } from "./narrationDockState";

export function NarrationDockPanel({
  title, accent, step, state, total, progress, busy, live, canPlay,
  status, rosterError, roster, chosen, cached, playRef,
  dispatch, onPlayPause, onCollapse, onChooseNarrator, onClearCache,
}: {
  title: string;
  /** The section's hue, already resolved — the panel does no colour thinking. */
  accent: string;
  step: NarrationStep | undefined;
  state: DockState;
  total: number;
  progress: number;
  busy: boolean;
  live: boolean;
  canPlay: boolean;
  status: string;
  rosterError: string | null;
  roster: Narrator[] | null;
  chosen: string;
  cached: number;
  playRef: RefObject<HTMLButtonElement | null>;
  dispatch: Dispatch<DockEvent>;
  onPlayPause: () => void;
  onCollapse: () => void;
  onChooseNarrator: (id: string) => void;
  onClearCache: () => void;
}) {
  return (
    <div
      className="glass-panel rounded-3xl p-4"
      style={{ boxShadow: `0 24px 70px -30px ${accent}, inset 0 0 0 1px hsl(0 0% 100% / 0.04)` }}
    >
      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-jetbrains text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">
            audible docs
          </div>
          <h2 className="font-instrument mt-0.5 truncate text-lg leading-tight text-white">
            {title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse the narration dock"
          aria-expanded
          className="shrink-0 cursor-pointer rounded-full border border-white/12 px-2 py-1 text-[12px] leading-none text-white/60 transition hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ outlineColor: accent }}
        >
          ▾
        </button>
      </div>

      {/* what is being said, right now */}
      <div className="mt-3 min-h-[3.5rem] rounded-2xl border border-white/8 bg-black/30 px-3 py-2.5">
        <div className="font-jetbrains flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-white/45">
          <span className="truncate">{step?.block.label ?? "—"}</span>
          <span className="shrink-0 tabular-nums">
            {total ? `${Math.min(state.index + 1, total)}/${total}` : "0/0"}
          </span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-white/85">
          {step?.sentence ?? "Nothing to read on this page."}
        </p>
      </div>

      {/* progress — transform-only, so it costs no layout */}
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10" aria-hidden>
        <span
          className="block h-full origin-left rounded-full"
          style={{
            background: `linear-gradient(90deg, ${accent}88, ${accent})`,
            transform: `scaleX(${progress})`,
            transition: "transform 300ms var(--gt-ease)",
          }}
        />
      </div>

      {/* transport */}
      <div className="mt-3 flex items-center gap-2">
        <button
          ref={playRef}
          type="button"
          onClick={onPlayPause}
          disabled={!canPlay}
          aria-label={state.phase === "playing" ? "Pause the narration" : "Play the narration"}
          aria-pressed={state.phase === "playing"}
          className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full text-[13px] text-slate-950 transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: accent, outlineColor: accent }}
        >
          {state.phase === "playing" ? "❙❙" : busy ? "…" : "▶"}
        </button>
        <TransportButton label="Previous sentence" onClick={() => dispatch({ t: "prev" })} disabled={!canPlay || state.index === 0}>
          ⏮
        </TransportButton>
        <TransportButton label="Next sentence" onClick={() => dispatch({ t: "next", total })} disabled={!canPlay}>
          ⏭
        </TransportButton>
        <TransportButton label="Stop the narration" onClick={() => dispatch({ t: "stop" })} disabled={!live}>
          ■
        </TransportButton>
        <span aria-hidden className="ml-auto flex h-5 items-end gap-[3px] opacity-70">
          <EqBars bars={6} height={20} />
        </span>
      </div>

      {/* narrator */}
      <label className="mt-3 block">
        <span className="font-jetbrains text-[10px] uppercase tracking-[0.16em] text-white/45">
          narrator
        </span>
        <select
          value={chosen}
          onChange={(e) => onChooseNarrator(e.target.value)}
          disabled={!roster?.length}
          className="font-jetbrains mt-1 w-full cursor-pointer rounded-xl border border-white/12 bg-black/40 px-3 py-2 text-[12px] text-white/85 focus:border-cyan-400/40 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value={AUTO_NARRATOR}>auto — one voice per section</option>
          {(roster ?? []).map((c) => (
            <option key={c.character_id} value={c.character_id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {/* honest status — never a bare spinner */}
      <div className="mt-2.5 flex items-start justify-between gap-3">
        <p
          role="status"
          aria-live="polite"
          className={`font-jetbrains text-[11px] leading-relaxed ${
            state.phase === "error" || rosterError ? "text-amber-300/90" : "text-white/50"
          }`}
        >
          {status}
        </p>
        {cached > 0 && (
          <button
            type="button"
            onClick={onClearCache}
            className="font-jetbrains shrink-0 cursor-pointer text-[10px] uppercase tracking-[0.14em] text-white/35 transition hover:text-white/70 focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ outlineColor: accent }}
          >
            clear
          </button>
        )}
      </div>
    </div>
  );
}

function TransportButton({
  label, onClick, disabled, children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full border border-white/12 text-[11px] text-white/70 transition hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
