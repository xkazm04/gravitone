"use client";

// Pieces both re-voice directions draw the same way. Hoisted on day one so
// the round is a choice about WHERE the lines live, never a disagreement about
// how a verdict, a slot or a clock is rendered.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { fitVerdict, type RevoiceFit } from "./data";
import { tc } from "./parts";
import type { Dub, DubLine } from "./useDub";

/** A colour per Character, the same hash the console's rail and script rows
 *  already use — a line's speaker must look the same everywhere on the page. */
export function hueOf(characterId: string): number {
  return (characterId.length * 47) % 360;
}

/** What the fit ladder did to one line, as a pill. The words come from
 *  `fitVerdict`, which is shared with the voiceover meters, so "spills 1.3s"
 *  cannot mean two different things on two surfaces. */
export function FitBadge({ fit }: { fit: RevoiceFit | null }) {
  if (!fit) {
    return (
      <span className="font-jetbrains rounded-full border border-white/12 px-2 py-0.5 text-[11px] text-white/40">
        not dubbed yet
      </span>
    );
  }
  const v = fitVerdict(fit);
  const skin =
    v.tone === "error" ? "border-rose-400/30 bg-rose-400/10 text-rose-200"
    : v.tone === "warn" ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
    : v.tone === "muted" ? "border-white/12 text-white/50"
    : "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";
  return (
    <span className={`font-jetbrains rounded-full border px-2 py-0.5 text-[11px] ${skin}`}>
      {v.label}
    </span>
  );
}

/** In / out for one slot. Seconds, typed — the scan that produced a line knows
 *  them to a tenth and a dubber thinks in them. */
export function SlotClock({ start, end, onChange, compact = false }: {
  start: number;
  end: number;
  onChange: (p: { start?: number; end?: number }) => void;
  compact?: boolean;
}) {
  const bad = end <= start;
  const field = `font-jetbrains rounded-md border bg-black/40 px-1.5 py-0.5 text-[11px] text-white/85 focus:outline-none ${
    bad ? "border-rose-400/40" : "border-white/15 focus:border-cyan-400/40"
  }`;
  return (
    <span className="flex shrink-0 items-center gap-1" title={bad ? "the out must be later than the in" : undefined}>
      {!compact && <span className="font-jetbrains text-[11px] uppercase text-white/40">in</span>}
      <input
        type="number" min={0} step={0.1} value={start} aria-label="Slot in, seconds"
        onChange={(e) => onChange({ start: Number(e.target.value) })}
        className={`w-14 ${field}`}
      />
      <span className="text-white/25">→</span>
      <input
        type="number" min={0} step={0.1} value={end} aria-label="Slot out, seconds"
        onChange={(e) => onChange({ end: Number(e.target.value) })}
        className={`w-14 ${field}`}
      />
      <span className="font-jetbrains text-[11px] text-white/40">{(end - start).toFixed(1)}s</span>
    </span>
  );
}

/** How the brain is allowed to touch the lines, and the one button that runs
 *  the dub. Lives with whoever owns the lines — the picture above does not
 *  decide what happens to words it does not hold. */
export function DubControls({ dub, lines, label = "Dub ▶" }: {
  dub: Dub;
  lines: DubLine[];
  label?: string;
}) {
  const blocked = dub.blockedFor(lines);
  const running = dub.job?.status === "running";
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Toggle on={dub.direct} onChange={dub.setDirect}
          label="compose the read"
          hint="the brain picks one emotion per line from what each Character has actually recorded — off, every line is spoken in the baseline voice" />
        <Toggle on={dub.rewrite} onChange={dub.setRewrite}
          label="shorten to fit"
          hint="a line that cannot fit its slot may be reworded — the new words are shown, never swapped in silently" />
        <button
          onClick={() => void (running ? dub.reset() : dub.run(lines))}
          disabled={!running && (!!blocked || dub.submitting)}
          title={running ? "Abandon this dub" : (blocked ?? "Replace the dialogue and render the video")}
          className={`font-jetbrains cursor-pointer rounded-lg border px-3 py-1.5 text-[11px] transition disabled:opacity-40 ${
            running
              ? "border-white/15 text-white/70 hover:border-rose-400/40 hover:text-rose-200"
              : "border-cyan-400/30 bg-cyan-400/10 text-cyan-200 enabled:hover:bg-cyan-400/20"
          }`}
        >
          {running ? "cancel dub" : dub.submitting ? "sending…" : label}
        </button>
      </div>
      {blocked && !running && (
        <p className="font-jetbrains mt-2 text-[11px] text-white/55">{blocked}</p>
      )}
      {dub.error && <ErrorBanner>{dub.error}</ErrorBanner>}
    </div>
  );
}

function Toggle({ on, onChange, label, hint }: {
  on: boolean; onChange: (v: boolean) => void; label: string; hint: string;
}) {
  return (
    <label title={hint}
      className="font-jetbrains flex cursor-pointer items-center gap-2 text-[11px] text-white/60">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-cyan-300" />
      {label}
    </label>
  );
}

/** The dub's slots laid out on the video's clock, to scale. Before a run it
 *  draws the sheet being written (so the gaps and overlaps are visible while
 *  they can still be fixed); after one, each block carries its verdict. */
export function SlotRibbon({ slots, activeId, onPick, height = "h-12" }: {
  slots: { line: DubLine; fit: RevoiceFit | null }[];
  activeId?: string | null;
  onPick?: (line: DubLine) => void;
  height?: string;
}) {
  if (slots.length === 0) return null;
  const clock = Math.max(...slots.map((s) => s.line.end), 1);
  return (
    <div>
      <div className={`relative w-full overflow-hidden rounded-lg border border-white/8 bg-black/30 ${height}`}>
        {slots.map(({ line, fit }) => {
          const tone = fit ? fitVerdict(fit).tone : null;
          const skin =
            tone === "error" ? "border-rose-400/50 bg-rose-400/20"
            : tone === "warn" ? "border-amber-300/50 bg-amber-300/20"
            : tone === "ok" ? "border-cyan-300/50 bg-cyan-300/15"
            : "border-white/20 bg-white/[0.06]";
          const on = line.id === activeId;
          return (
            <button
              key={line.id}
              onClick={onPick ? () => onPick(line) : undefined}
              disabled={!onPick}
              title={`${tc(line.start)} → ${tc(line.end)} · ${line.text.slice(0, 60)}`}
              style={{
                left: `${(line.start / clock) * 100}%`,
                width: `${Math.max(0.6, ((line.end - line.start) / clock) * 100)}%`,
              }}
              className={`absolute inset-y-1 overflow-hidden rounded-md border transition ${skin} ${
                on ? "ring-1 ring-cyan-300" : ""
              } ${onPick ? "cursor-pointer hover:brightness-125" : ""}`}
            >
              <span className="absolute inset-x-0 top-0 h-[3px]"
                style={{ background: `hsl(${hueOf(line.characterId)} 80% 60%)` }} />
              <span className="font-jetbrains block truncate px-1 pt-[5px] text-left text-[10px] leading-tight text-white/80">
                {line.text || "—"}
              </span>
            </button>
          );
        })}
      </div>
      <div className="font-jetbrains mt-1 flex justify-between text-[11px] text-white/40">
        <span>0:00.0</span>
        <span>{tc(clock)}</span>
      </div>
    </div>
  );
}
