"use client";

// THE MARQUEE — the picture, above the console, in every mode. It owns no
// words: a click on it loads a line into the console's own composer, where the
// score, the emotion wheel, the A/B and the expression knobs already do
// everything words need.
//
// One picture, two verbs. NARRATE reads silent footage and writes a narration
// over it (a reel: scenes, one frame each, a line per scene). RE-VOICE replaces
// the dialogue of a video whose lines you have (a dub: slots on a clock, each
// one fitted to the room it has). They are different jobs on the backend and
// different crafts on screen, but they are the same question — what is the
// picture, and what is this Character doing to it — so they share a stage.
//
// The ribbon is drawn TO SCALE against the reel's own clock: a block's width is
// its share of the runtime, so a scene with three seconds of room LOOKS like
// three seconds of room next to one with twenty.

import { useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { frameUrl, mediaUrl } from "./data";
import { FitMeter, StepsRail, tc } from "./parts";
import { SlotRibbon } from "./dubParts";
import ReelDoor from "./ReelDoor";
import type { Reel, Scene } from "./useReel";
import type { Dub, DubLine } from "./useDub";

type Verb = "narrate" | "revoice";

export default function Marquee({ reel, dub, draft, characterName, onStage }: {
  reel: Reel;
  /** Present only while the re-voice round is open. Absent = the marquee that
   *  shipped: one verb, no switch, byte-for-byte the narrate stage. */
  dub?: Dub;
  /** The sheet being written, wherever it lives — the stage draws it on the
   *  clock before a run so gaps and overlaps are visible while they can still
   *  be fixed. After a run the submitted slots take over, because those are
   *  the ones the verdicts belong to. */
  draft?: DubLine[];
  characterName: string | null;
  /** load these words into the console's own composer */
  onStage: (text: string) => void;
}) {
  const [verb, setVerb] = useState<Verb>("narrate");
  const showing: Verb = dub ? verb : "narrate";

  return (
    <div className="glass-panel rounded-2xl p-4">
      {dub && (
        <div className="mb-3 flex items-center gap-1">
          {(["narrate", "revoice"] as const).map((v) => (
            <button key={v} onClick={() => setVerb(v)} aria-pressed={showing === v}
              title={v === "narrate"
                ? "Silent footage — read the picture and write a narration for it"
                : "A video whose dialogue you have — replace it with these Characters"}
              className={`font-jetbrains rounded-full border px-2.5 py-0.5 text-[11px] uppercase tracking-widest transition ${
                showing === v
                  ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
                  : "border-transparent text-white/50 hover:text-white/80"
              }`}>
              {v === "narrate" ? "narrate" : "re-voice"}
            </button>
          ))}
        </div>
      )}
      {showing === "narrate"
        ? <NarrateStage reel={reel} characterName={characterName} onStage={onStage} />
        : <RevoiceStage dub={dub!} draft={draft ?? []} onStage={onStage} />}
    </div>
  );
}

// ── narrate ──────────────────────────────────────────────────────────────────

function NarrateStage({ reel, characterName, onStage }: {
  reel: Reel; characterName: string | null; onStage: (t: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Before a reel lands the stage IS the door — same strip, same panel, so the
  // console does not jump when the picture arrives.
  if (!reel.ready || !reel.jobId) {
    return <ReelDoor reel={reel} characterName={characterName} />;
  }

  const total = reel.scenes.reduce((a, s) => a + s.budget, 0) || 1;
  const focused = reel.scenes.find((s) => s.i === reel.focus) ?? null;

  const go = (s: Scene) => {
    reel.setFocus(s.i);
    onStage(s.text);
    const v = videoRef.current;
    if (v) {
      v.currentTime = s.start + 0.05; // land inside the block, never on its seam
      void v.play().catch(() => { /* autoplay refused — the seek still landed */ });
    }
  };

  return (
    <>
      <div className="flex flex-col gap-4 lg:flex-row">
        <video
          ref={videoRef}
          src={mediaUrl("voiceover", reel.jobId, "video")}
          controls
          className="w-full shrink-0 rounded-xl border border-white/10 bg-black lg:w-[360px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">picture</p>
              <p className="mt-1 truncate text-base text-white">{reel.job?.source.title}</p>
              <p className="font-jetbrains mt-1 text-[11px] text-white/55">
                {tc(total)} · {reel.scenes.length} scenes · narrated by {characterName}
                {reel.job?.brain ? ` · written by ${reel.job.brain.backend}` : ""}
              </p>
            </div>
            <button
              onClick={() => void reel.reset()}
              className="font-jetbrains shrink-0 cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-rose-400/40 hover:text-rose-200"
            >
              new reel
            </button>
          </div>

          {focused && (
            <div className="mt-3 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.04] p-3">
              <p className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-200">
                scene {focused.i + 1} in the composer · {focused.budget.toFixed(1)}s of picture
              </p>
              <p className="mt-1 line-clamp-2 text-sm text-white/80">
                {focused.text || "(the writer left this scene silent)"}
              </p>
              {focused.fit && <div className="mt-2"><FitMeter fit={focused.fit} /></div>}
            </div>
          )}
        </div>
      </div>

      {/* the ribbon — the reel's clock, to scale */}
      <div className="mt-4">
        <div className="relative flex h-20 w-full gap-[3px] overflow-hidden rounded-lg" role="group" aria-label="Scenes">
          {reel.scenes.map((s) => {
            const on = s.i === reel.focus;
            return (
              <button
                key={s.i}
                onClick={() => go(s)}
                aria-pressed={on}
                title={`Scene ${s.i + 1} · ${tc(s.start)} · ${s.budget.toFixed(1)}s`}
                style={{ width: `${(s.budget / total) * 100}%` }}
                className={`group relative min-w-[10px] cursor-pointer overflow-hidden rounded-md border transition ${
                  on ? "border-cyan-400/60" : "border-white/10 hover:border-white/35"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={frameUrl(reel.jobId!, s.i)} alt=""
                  className={`absolute inset-0 h-full w-full object-cover transition ${on ? "opacity-70" : "opacity-35 group-hover:opacity-55"}`}
                />
                <span className="absolute inset-x-0 bottom-0 h-[3px]">
                  {s.fit && <FitMeter fit={s.fit} compact />}
                </span>
                <span className="font-jetbrains absolute left-1 top-1 rounded bg-black/50 px-1 text-[10px] text-white/80">
                  {s.i + 1}
                </span>
              </button>
            );
          })}
          <Playhead videoRef={videoRef} total={total} />
        </div>
        <p className="font-jetbrains mt-2 text-[11px] text-white/55">
          Click a scene to load its line into the composer below — the score, the emotion
          wheel and the expression knobs are the ones you already use. The reel keeps the
          narration it was built with; what you render here lands in the take log.
        </p>
      </div>
    </>
  );
}

// ── re-voice ─────────────────────────────────────────────────────────────────

function RevoiceStage({ dub, draft, onStage }: {
  dub: Dub; draft: DubLine[]; onStage: (t: string) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const j = dub.job;
  const summary = j?.result?.summary;
  // After a run the verdicts belong to the lines that produced them; before
  // one, the sheet being written is the only truth there is.
  const ribbon = dub.slots.length > 0
    ? dub.slots
    : draft.map((line) => ({ line, fit: null }));

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">source</span>
        <input
          type="url" value={dub.url} onChange={(e) => dub.setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…" aria-label="Dialogue video link"
          disabled={j?.status === "running"}
          className="font-jetbrains min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-[12px] text-white/85 placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none disabled:opacity-50"
        />
        {j && j.status !== "running" && (
          <button
            onClick={() => void dub.reset()}
            className="font-jetbrains shrink-0 cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-rose-400/40 hover:text-rose-200"
          >
            new dub
          </button>
        )}
      </div>

      {/* WHAT IS NOT HERE, said plainly: the source cannot be shown before the
          render. The box downloads it, replaces the speech and hands back one
          file — there is no preview of someone else's video to play in the
          meantime, and a black rectangle pretending otherwise would be worse. */}
      {!j && (
        <p className="font-jetbrains mt-2 text-[11px] text-white/55">
          The picture arrives with the dub — this box fetches the video, replaces its
          speech and returns the finished file. The strip below is the sheet you are
          writing, drawn on its own clock.
        </p>
      )}

      {j?.status === "running" && <div className="mt-4"><StepsRail job={j} stalled={dub.stalled} /></div>}
      {j?.status === "error" && <ErrorBanner>{j.error}</ErrorBanner>}
      {j?.status === "expired" && <ErrorBanner>this dub aged out on the box — run it again</ErrorBanner>}

      {j?.status === "done" && dub.jobId && (
        <div className="mt-4 flex flex-col gap-4 lg:flex-row">
          <video
            src={mediaUrl("revoice", dub.jobId, "video")} controls
            className="w-full shrink-0 rounded-xl border border-white/10 bg-black lg:w-[360px]"
          />
          <div className="min-w-0 flex-1">
            <p className="mt-1 truncate text-base text-white">{j.source.title}</p>
            {summary && (
              <p className="font-jetbrains mt-1 text-[11px] text-white/55">
                {summary.lines} lines · {summary.verbatim} verbatim · {summary.atempo} time-stretched ·{" "}
                {summary.rewritten} rewritten
                {j.brain ? ` · directed by ${j.brain.backend}` : ""}
              </p>
            )}
            {!!summary?.spilling && (
              <p className="font-jetbrains mt-1 text-[11px] text-amber-200">
                {summary.spilling} line{summary.spilling > 1 ? "s" : ""} still run past their slot — the
                picture keeps playing under them
              </p>
            )}
            {!!summary?.failed && (
              <p className="font-jetbrains mt-1 text-[11px] text-rose-300">
                {summary.failed} line{summary.failed > 1 ? "s" : ""} could not be re-performed
              </p>
            )}
            <a href={mediaUrl("revoice", dub.jobId, "video")} download
               className="font-jetbrains mt-3 inline-block cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-cyan-400/40 hover:text-cyan-200">
              download the dub
            </a>
          </div>
        </div>
      )}

      {ribbon.length > 0 && (
        <div className="mt-4">
          <SlotRibbon
            slots={ribbon}
            activeId={active}
            onPick={(line) => { setActive(line.id); onStage(line.text); }}
            height="h-14"
          />
          <p className="font-jetbrains mt-2 text-[11px] text-white/55">
            {dub.slots.length > 0
              ? "Click a slot to put its line in the composer — a take you render there is a replacement you keep in the log; the dub itself keeps what it was rendered with."
              : "The sheet on its clock. Overlapping blocks will speak over each other, and a gap is silence the original had words in."}
          </p>
        </div>
      )}

      {j?.limits?.length ? (
        <ErrorBanner severity="warning">{j.limits.join(" · ")}</ErrorBanner>
      ) : null}
    </>
  );
}

/** The one thing on this surface that moves with the video, isolated so the
 *  ribbon's N blocks do not re-render four times a second (the same discipline
 *  as the console's LiveProgress). */
function Playhead({ videoRef, total }: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  total: number;
}) {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setAt(v.currentTime);
    const onEnd = () => setAt(null);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnd);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnd);
    };
  }, [videoRef]);
  if (at === null) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-px bg-cyan-300 shadow-[0_0_8px_var(--gt-glow-cyan)]"
      style={{ left: `${Math.min(100, (at / total) * 100)}%` }}
    />
  );
}
