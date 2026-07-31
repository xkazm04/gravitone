"use client";

import { useMemo, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import type { Recipe } from "../_state/machine";
import { startLadder, vote, type Ladder } from "../_state/audition";
import { takeKey, type Take } from "../_state/useAudition";

/**
 * The Audition Room drill-down for ONE emotion.
 *
 * It is opt-in and it is never on the critical path: the ledger row above it
 * still commits the default splice in one click. What it adds is the answer to
 * the question this whole product exists for — "does the clone sound like me?" —
 * before anything irreversible happens.
 *
 * Two design commitments, both from the batch's rules:
 *   * **Blind by default.** The two players are X and Y with no labels: the vote
 *     is the user's ear, and "this one is the longest takes" is the bias that
 *     would replace it. The winner is revealed after each vote.
 *   * **Named facts, not scores.** Every candidate states the backend's own
 *     words (`label` / `how`) plus its measured length. Nothing is scored out of
 *     ten, and nothing is asserted that was not measured.
 *
 * Playback deliberately reuses the page's single audio element (`play`/`playing`)
 * rather than introducing another player: the Signal Layer's <TakePlayer> is the
 * one primitive this surface should eventually use, and it is swapped in at the
 * call site, not forked here.
 */
export default function AuditionPanel(props: {
  emotion: string;
  label: string;
  hue: number;
  recipes: Recipe[];
  chosenId?: string;
  takes: Record<string, Take>;
  request: (emotion: string, recipe: string, text: string) => Promise<string | null>;
  play: (url: string, id: string) => void;
  playing: string | null;
  onChoose: (recipeId: string | null) => void;
  onClose: () => void;
}) {
  const { emotion, label, hue, recipes, chosenId, takes, request, play, playing } = props;
  const [text, setText] = useState("");
  const [ladder, setLadder] = useState<Ladder>(() => startLadder(recipes));
  const [byName, setByName] = useState(false);

  // Restarting is a first-class action: an A/B whose result you cannot revisit
  // is a decision the user is stuck with for a reason they may have forgotten.
  const restart = () => setLadder(startLadder(recipes));

  const chosen = useMemo(
    () => recipes.find((r) => r.id === chosenId) ?? null,
    [recipes, chosenId],
  );

  async function hear(recipe: Recipe, slot: string) {
    const key = takeKey(emotion, recipe.id, text);
    const known = takes[key];
    const id = `aud-${emotion}-${slot}`;
    if (known?.url) { play(known.url, id); return; }
    const url = await request(emotion, recipe.id, text);
    if (url) play(url, id);
  }

  function takeOf(recipe: Recipe | null): Take | undefined {
    return recipe ? takes[takeKey(emotion, recipe.id, text)] : undefined;
  }

  // Backpressure and failures come from the takes themselves: the two players
  // are the only things that can be busy, so their state is stated where they are.
  const notices = [takeOf(ladder.x), takeOf(ladder.y)]
    .filter((t): t is Take => Boolean(t?.error));

  function Player({ recipe, slot, name }: { recipe: Recipe; slot: string; name: string }) {
    const t = takeOf(recipe);
    const id = `aud-${emotion}-${slot}`;
    const on = playing === id;
    return (
      <div className="glass-panel flex-1 rounded-xl p-4">
        <div className="font-jetbrains flex items-center justify-between text-[11px] uppercase tracking-widest text-white/50">
          <span>take {name}</span>
          {t?.seconds !== undefined && <span className="text-white/35">{t.seconds}s</span>}
        </div>
        <button
          onClick={() => void hear(recipe, slot)}
          disabled={t?.loading}
          aria-label={`${on ? "Pause" : "Play"} take ${name} — the cloned voice`}
          title="the cloned voice speaking your line"
          className="mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2.5 text-[13px] text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-default disabled:opacity-45"
        >
          <span aria-hidden>{t?.loading ? "◌" : on ? "⏸" : "▶"}</span>
          {t?.loading ? "synthesizing…" : on ? "playing" : t?.url ? "play again" : "hear take"}
        </button>
        <button
          onClick={() => setLadder(vote(ladder, slot as "x" | "y"))}
          disabled={!t?.url}
          aria-label={`Vote: take ${name} sounds more like the speaker`}
          className="font-jetbrains mt-2 w-full cursor-pointer rounded-lg border border-white/12 px-3 py-2 text-[11px] text-white/70 transition hover:border-white/30 hover:text-white disabled:cursor-default disabled:opacity-35"
        >
          sounds more like the speaker
        </button>
        {!t?.url && !t?.loading && (
          <p className="font-jetbrains mt-2 text-[10px] leading-snug text-white/35">
            hear it before voting
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-jetbrains flex items-center gap-2 text-[11px] uppercase tracking-widest text-cyan-300/85">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${hue} 85% 62%)` }} />
            audition · {label}
          </div>
          <p className="mt-1 max-w-xl text-[13px] leading-snug text-white/65">
            These are <span className="text-white">cloned voices</span> — not the recording.
            Each take is a different way of splicing the same speech into this
            emotion&apos;s stem. Pick the one that sounds most like the speaker; only
            that one gets cloned for real.
          </p>
        </div>
        <button
          onClick={props.onClose}
          className="font-jetbrains cursor-pointer rounded-full border border-white/12 px-3 py-1 text-[11px] text-white/60 transition hover:text-white"
        >
          close
        </button>
      </div>

      <label className="mt-4 block">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/45">
          line to speak
        </span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={240}
          placeholder="This is how I sound when I say something I mean."
          className="font-hanken mt-1.5 w-full rounded-xl border border-white/12 bg-white/[0.03] px-3.5 py-2 text-[14px] text-white placeholder:text-white/35 focus:border-cyan-400/40 focus:outline-none"
        />
        <span className="font-jetbrains mt-1 block text-[10px] text-white/35">
          leave it empty for the studio&apos;s own line · changing it re-synthesizes both takes
        </span>
      </label>

      {notices.map((t, i) => (
        <ErrorBanner key={i} severity="warning">
          {t.error}
          {t.busySec ? ` — the backend asked for ${t.busySec}s before the next attempt.` : ""}
        </ErrorBanner>
      ))}

      {!byName && !ladder.done && ladder.x && ladder.y && (
        <>
          <div className="font-jetbrains mt-4 text-[11px] uppercase tracking-widest text-white/45">
            round {ladder.round + 1} · unlabelled on purpose
          </div>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Player recipe={ladder.x} slot="x" name="X" />
            <Player recipe={ladder.y} slot="y" name="Y" />
          </div>
        </>
      )}

      {ladder.lastPick && (
        <p className="font-jetbrains mt-3 text-[11px] text-cyan-200/85">
          you picked <span className="text-white">{ladder.lastPick.label}</span> —{" "}
          {ladder.lastPick.how} ({ladder.lastPick.seconds}s)
        </p>
      )}

      {!byName && ladder.done && ladder.winner && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => props.onChoose(ladder.winner!.id)}
            className="cursor-pointer rounded-full bg-cyan-300 px-4 py-2 text-[13px] font-semibold text-slate-950 transition hover:brightness-110"
          >
            Clone “{ladder.winner.label}” for {label}
          </button>
          <button
            onClick={restart}
            className="font-jetbrains cursor-pointer rounded-full border border-white/12 px-3 py-1.5 text-[11px] text-white/65 transition hover:text-white"
          >
            ↻ compare again
          </button>
        </div>
      )}

      <div className="mt-4 border-t border-white/8 pt-3">
        <button
          onClick={() => setByName((v) => !v)}
          aria-expanded={byName}
          className="font-jetbrains cursor-pointer text-[11px] text-white/50 transition hover:text-white"
        >
          {byName ? "← back to the blind comparison" : "or choose a take by name →"}
        </button>
        {byName && (
          <ul className="mt-3 space-y-2">
            {recipes.map((r) => {
              const t = takeOf(r);
              const isChosen = chosen?.id === r.id;
              return (
                <li key={r.id} className="glass-panel flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5">
                  <button
                    onClick={() => void hear(r, r.id)}
                    disabled={t?.loading}
                    aria-label={`${playing === `aud-${emotion}-${r.id}` ? "Pause" : "Play"} the ${r.label} take as a cloned voice`}
                    className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110 disabled:opacity-45"
                  >
                    {t?.loading ? "◌" : playing === `aud-${emotion}-${r.id}` ? "⏸" : "▶"}
                  </button>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-[13px] text-white">
                      {r.label}
                      {r.default && (
                        <span className="font-jetbrains rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-white/60">
                          default
                        </span>
                      )}
                      <span className="font-jetbrains text-[11px] text-white/45">
                        {r.seconds}s · {r.segments} segment{r.segments === 1 ? "" : "s"}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-white/50">{r.how}</span>
                  </span>
                  <button
                    onClick={() => props.onChoose(r.default ? null : r.id)}
                    aria-pressed={isChosen || (!chosen && Boolean(r.default))}
                    className={`font-jetbrains shrink-0 cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] transition ${
                      isChosen || (!chosen && r.default)
                        ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                        : "border-white/12 text-white/55 hover:text-white"
                    }`}
                  >
                    {isChosen || (!chosen && r.default) ? "✓ cloning this" : "clone this"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
