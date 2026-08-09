"use client";

// CONSOLE (round 2) — operator/terminal metaphor, now Character-aware.
//   * Pick a Character (a speaker); metatags switch its emotion Voices inline.
//   * Expression panel exposes the model's REAL knobs (temperature / stability /
//     quality). Pocket TTS has no emotion or speed parameter — expression lives
//     in the reference audio, which is why emotions are Voices, not sliders.
//   * A missing emotion is substituted with the nearest recorded one, then
//     baseline; the take's segment ribbon shows what actually ran.
//
// THIS FILE IS THE ASSEMBLY. Each region of the studio is its own module —
// PlaygroundNotices, PlaygroundCharacterRail, PlaygroundComposeBay,
// PlaygroundExpression, PlaygroundTakeLog — and each self-contained concern is
// its own hook: usePlaygroundRoster, usePlaygroundComposer (+ its durability),
// usePlaygroundTakes, usePlaygroundGenerate, usePlaygroundEngine,
// usePlaygroundSharing, usePlaygroundTakeActions. What stays here is only what
// more than one of them needs, the wiring between them, and the page's layout.
//
// The hooks are called in the order their effects used to run in: the roster
// first, then the composer's restore, then the take log's, then the run, then
// the health poll (whose cadence depends on the run). Keep it that way.

import { useMounted } from "@/lib/useMounted";
import { useStillMotion } from "@/lib/useStillMotion";
import { NEW_KEY_SLOT } from "@/lib/useAuth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eyebrow } from "@/components/ui/Primitives";
import { EMOTION_IDS } from "@/lib/emotions";
import {
  composerLimit, composerWarnings, isTimingBasis, stripTags,
} from "./playgroundHelpers";
import { DEFAULT_OUTPUT_FORMAT, type OutputFormat } from "@/lib/audioFormats";
import { useAudioPlayer } from "./useAudioPlayer";
import EmotionPicker from "./EmotionPicker";
import EmotionAB from "./EmotionAB";
import LiveStage from "../_live/LiveStage";
// The video extension (../_video) — the MARQUEE, which won the video round
// against a contained "reel bay" mode. The thesis it won on: the picture is not
// a mode you enter, it is a stage above the console that stays put, and it owns
// no words. A scene click loads that line into this console's own composer, so
// the score, the emotion wheel, the A/B, the expression knobs and the take log
// remain the only way words are written and rendered here.
import { useReel } from "../_video/useReel";
import Marquee from "../_video/Marquee";
// THE DUB SHEET — the marquee's second verb (re-voice: replace a video's
// dialogue) won its round against a bench of its own, on this thesis: a dub is
// a multi-character script whose lines are pinned to someone else's clock, and
// this console already HAS a multi-character script composer. So script mode
// grows a clock rather than gaining a rival. One composer, two exits: Generate
// makes a take, Dub makes a film.
import { useDub, type DubLine } from "../_video/useDub";
import { PlaygroundNotices } from "./PlaygroundNotices";
import { PlaygroundCharacterRail } from "./PlaygroundCharacterRail";
import { PlaygroundComposeBay } from "./PlaygroundComposeBay";
import { PlaygroundExpression } from "./PlaygroundExpression";
import { PlaygroundTakeLog } from "./PlaygroundTakeLog";
import { RenderStatus } from "./PlaygroundRenderStatus";
import { renderEstimate } from "./playgroundEstimate";
import { usePlaygroundRoster } from "./usePlaygroundRoster";
import { usePlaygroundComposer } from "./usePlaygroundComposer";
import { usePlaygroundComposerDurability } from "./usePlaygroundComposerDurability";
import { usePlaygroundTakes } from "./usePlaygroundTakes";
import { usePlaygroundGenerate } from "./usePlaygroundGenerate";
import { usePlaygroundEngine } from "./usePlaygroundEngine";
import { usePlaygroundSharing } from "./usePlaygroundSharing";
import { usePlaygroundTakeActions } from "./usePlaygroundTakeActions";

export default function PlaygroundConsole() {
  // Resolved once, here, and passed down: framer's own hook cannot be trusted
  // by anything server-rendered, and one reading keeps every accent in step.
  const still = useStillMotion();
  const mounted = useMounted();
  // The prefix of an API key auto-minted during this session's first sign-in.
  // Announced HERE, as a secondary aside, rather than by making a credentials
  // panel the first screen of a speech product (lib/useAuth::NEW_KEY_SLOT).
  const [newKeyPrefix, setNewKeyPrefix] = useState<string | null>(null);
  const [liveOn, setLiveOn] = useState(false);
  const [liveActive, setLiveActive] = useState(false);
  // What the next take is rendered as. It sits beside Generate rather than in
  // the expression panel because it is a decision about the FILE you keep, not
  // about how the voice sounds.
  const [format, setFormat] = useState<OutputFormat>(DEFAULT_OUTPUT_FORMAT);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [codeFor, setCodeFor] = useState<string | null>(null); // take id with the code panel open
  // take id whose punch-in drill-down is open. Editing is opt-in per take: the
  // default card must stay as uncluttered as it was before there was an editor.
  const [punchFor, setPunchFor] = useState<string | null>(null);
  const seq = useRef(0);
  const composerRef = useRef<HTMLDivElement>(null); // scroll target for "reuse"

  const { playingId, paused, progress: playhead, toggle, stop, seekTo } = useAudioPlayer();

  const { characters, preferred, rosterErr } = usePlaygroundRoster(mounted);

  const composer = usePlaygroundComposer({ characters });
  const {
    text, setText, expr, setExpr, mode, setMode, charId, setCharId,
    script, setScript, activeLine, setActiveLine,
    scriptApplied, plain, estSec, scriptLines, scriptChars, insertEmotion,
  } = composer;
  const { composerErr, composerNotice, setComposerNotice } = usePlaygroundComposerDurability({
    text, script, expr, mode, charId, activeLine,
    setText, setScript, setExpr, setMode, setCharId, setActiveLine,
    characters, preferred, mounted,
  });

  // First sign-in minted an API key. This is the ONLY thing the studio says
  // about it — one dismissible line, on the screen the user actually wanted.
  useEffect(() => {
    try {
      const p = sessionStorage.getItem(NEW_KEY_SLOT);
      if (!p) return;
      sessionStorage.removeItem(NEW_KEY_SLOT);
      setNewKeyPrefix(p);
    } catch {
      /* storage unavailable — the key still exists, it just goes unannounced */
    }
  }, []);

  // In Script mode the emotion palette follows the line being edited (each line
  // may name a different Character); in Solo mode it follows the character rail.
  const activeCharId = mode === "script" ? (script[activeLine]?.characterId ?? charId) : charId;
  const character = useMemo(
    () => characters.find((c) => c.character_id === activeCharId),
    [characters, activeCharId],
  );
  const charName = (id: string) => characters.find((c) => c.character_id === id)?.name ?? id;

  const takesApi = usePlaygroundTakes(mounted);
  const { takes, addTake, storageErr, setStorageErr, announcement, setAnnouncement } = takesApi;

  const {
    busy, busyNotice, retryIn, startedAt, streamedSec,
    toast, setToast, fallbackNotice, generate, cancelGenerate,
  } = usePlaygroundGenerate({
    mode, text, plain, expr, format, character, scriptLines, charName,
    addTake, setAnnouncement, seq, mounted,
  });

  const { healthStale, metric, queued, inFlight, metricsUnavailable, engineNotice } =
    usePlaygroundEngine(busy);

  const sharing = usePlaygroundSharing({ takes, mounted });
  const {
    shares, copy, copied, copyFailed, allowReperform, setAllowReperform,
    shareErr, setShareErr, reviewSel, setReviewSel, reviewBusy, reviewUrl, reviewErr,
    share, createReview,
  } = sharing;

  const { reuseTake, removeTake, commitPunch } = usePlaygroundTakeActions({
    composer, takesApi, sharing, characters, charName, seq, composerRef,
    setCodeFor, setPunchFor, setComposerNotice,
  });

  // The reel. Called unconditionally (hooks are not optional) and idle until a
  // job exists, so a console with no `video` prop pays one useState pass and
  // nothing else. Its narrator IS the rail's selection — the fusion this
  // extension exists for: one roster, one Character, one set of knobs.
  const reel = useReel({ characterId: charId });
  /** Put words in the composer. Both directions hand their scene's line to the
   *  console this way, so Generate/expression/format/takes stay the ONLY
   *  synthesis path — a second one would be a second set of bugs. Stable
   *  identity: the bay mirrors the focused row through it on every edit. */
  const stageLine = useCallback((t: string) => setText(t), [setText]);

  // The dub. Same posture as the reel: one hook, idle until a job exists, and
  // the lines are supplied by whoever owns them at `run` time.
  const dubState = useDub();
  // One map for the whole script, not one rebuilt per row: `slotsFor` walks
  // every line to fill the gaps deterministically, and calling it inside the
  // row loop made rendering a script quadratic in its own length.
  const dubSlots = useMemo(
    () => dubState.slotsFor(script.map((l) => l.id)),
    [script, dubState],
  );
  /** The sheet: script mode's own lines, on the clock. The words are the PLAIN
   *  ones — `[emotion]` tags are this console's grammar for switching Voices
   *  mid-take, and a dub's read is composed per line instead, so sending the
   *  markup would only give the engine brackets to say out loud. */
  const dubDraft = useMemo<DubLine[]>(
    () => script
      .filter((l) => l.text.trim())
      .map((l) => ({
        id: l.id,
        characterId: l.characterId,
        text: stripTags(l.text),
        start: dubSlots[l.id]?.start ?? 0,
        end: dubSlots[l.id]?.end ?? 0,
      })),
    [script, dubSlots],
  );
  // The active Character's palette: base scale + its custom slots.
  const scale = useMemo(
    () => (character?.scale?.length ? character.scale : EMOTION_IDS),
    [character],
  );

  // The server's limits, stated BEFORE the request (service/app.py's 8000-char
  // and 64-line caps, the proxy's 128 KB body). One pure function so the rule
  // is testable and lives next to the constants it enforces.
  const blocked = useMemo(() => composerLimit({ mode, text, script }), [mode, text, script]);

  // …and what the tags in it will DO. Advisory, not a refusal: a malformed tag
  // is accepted by the engine and spoken out loud, which is a worse outcome
  // than a rejection and had no signal at all before this.
  //
  // The vocabulary is what EXISTS on the relevant Character's scale — in a
  // scene, the union of the scales of the Characters actually cast in it, so a
  // tag legal for one speaker is not reported as a typo because of another.
  const knownEmotions = useMemo(() => {
    if (mode === "solo") return scale;
    const cast = new Set(script.map((l) => l.characterId));
    const seen = new Set<string>();
    for (const c of characters) {
      if (!cast.has(c.character_id)) continue;
      for (const e of (c.scale?.length ? c.scale : EMOTION_IDS)) seen.add(e);
    }
    return seen.size > 0 ? [...seen] : EMOTION_IDS;
  }, [mode, scale, script, characters]);
  const warnings = useMemo(
    () => composerWarnings({ mode, text, script, known: knownEmotions }),
    [mode, text, script, knownEmotions],
  );

  const canGenerate = !blocked && (mode === "script" ? scriptLines.length > 0 : (!!plain && !!character));
  // --- render estimate ------------------------------------------------------
  const estAudioSec = mode === "script"
    ? Math.max(1.5, Math.round(scriptChars * 0.055 * 10) / 10)
    : estSec;
  // Only a take whose timing means what this build thinks it means may
  // calibrate an estimate — a record restored from before the wall-clock rtf
  // fix carries a summed per-segment factor that understates the wait
  // (shared.ts::TAKE_TIMING_VERSION).
  const lastRtf = takes.find(isTimingBasis)?.rtf;
  const { etaSec, etaBasisLabel, noEtaLabel } = renderEstimate({
    estAudioSec, lastRtf, liveRtfRaw: metric("realtime_factor"), metricsUnavailable,
  });

  return (
    <div className="pb-24">
      {/* The completion announcement. A take arriving is a visual-only event —
          a new card slides into a log that is not a live region — so this is
          the only thing that tells a screen-reader user their render finished. */}
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {/* Pressing a chip or a wheel spoke in SCRIPT mode was a visual-only
          event too: the words lit up and nothing was said. `aria-live` without
          `role="status"` announces just the same, and leaves the take-completion
          region above as the ONE status role on this page — two of them are two
          things a test (and a screen-reader user's mental model) has to tell
          apart by nothing. */}
      <p aria-live="polite" data-testid="script-applied" className="sr-only">{scriptApplied}</p>
      <EmotionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={insertEmotion}
        available={character?.emotions ?? ["baseline"]}
        scale={scale}
        characterName={character?.name ?? "Character"}
        characterId={character?.character_id ?? ""}
      />
      <Eyebrow>free playground</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">Compose a take.</h1>
      <p className="mt-2 max-w-2xl text-base text-white/70">
        Pick a <span className="text-white">Character</span>, then select words and give them an{" "}
        <span className="text-white">emotion</span> to switch its <span className="text-white">Voices</span>{" "}
        mid-sentence. Direction is kept as spans beside your words and written out as{" "}
        <span className="font-jetbrains text-cyan-300">[emotion]…[/emotion]</span> for the engine. A
        missing emotion uses the nearest recorded one, and only then baseline.
      </p>

      <PlaygroundNotices
        newKeyPrefix={newKeyPrefix} onDismissKey={() => setNewKeyPrefix(null)}
        rosterErr={rosterErr} fallbackNotice={fallbackNotice} storageErr={storageErr}
        composerErr={composerErr}
        composerNotice={composerNotice} onDismissComposerNotice={() => setComposerNotice(null)}
        shareErr={shareErr} onDismissShareErr={() => setShareErr(null)}
        busyNotice={busyNotice} retryIn={retryIn} busy={busy} onRetry={() => void generate()}
        engineNotice={engineNotice} healthStale={healthStale}
        toast={toast} onDismissToast={() => setToast(null)}
      />

      {/* THE MARQUEE — the stage sits above everything and stays there in
          every mode. It contributes the two things the composer cannot know on
          its own (the picture, and how long each line has to be); the composer
          below stays the one place words are written. */}
      <div className="mt-8">
        <Marquee reel={reel} characterName={character?.name ?? null} onStage={stageLine}
          dub={dubState} draft={dubDraft} />
      </div>

      {/* character rail */}
      <PlaygroundCharacterRail
        characters={characters} charId={charId} onSelect={setCharId} preferred={preferred} />

      <div className="mt-6 grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
        {/* compose bay */}
        <PlaygroundComposeBay
          composer={composer} composerRef={composerRef}
          characters={characters} character={character} scale={scale} charName={charName}
          liveOn={liveOn} setLiveOn={setLiveOn} onOpenWheel={() => setPickerOpen(true)}
          dubState={dubState} dubSlots={dubSlots} dubDraft={dubDraft}
          format={format} setFormat={setFormat}
          blocked={blocked} warnings={warnings} canGenerate={canGenerate}
          busy={busy} liveActive={liveActive}
          generate={generate} cancelGenerate={cancelGenerate}
        />

        {/* expression */}
        <PlaygroundExpression expr={expr} setExpr={setExpr} />
      </div>

      {/* Emotion A/B — Solo only: it holds ONE line and ONE Character still and
          varies exactly one thing, which a multi-character script is not. It is
          handed the console's single transport rather than owning an audio
          element, so A and B can never play over each other. */}
      {mode === "solo" && character && (
        <EmotionAB
          characterId={character.character_id} characterName={character.name}
          scale={scale} recorded={character.emotions ?? []}
          text={text} expr={expr} format={format}
          playingId={playingId} paused={paused} toggle={toggle} stop={stop}
          onKeep={(pair) => pair.forEach(addTake)}
        />
      )}

      {liveOn && (
        <LiveStage characters={characters} charId={charId} generateBusy={busy} onTake={addTake}
          onScript={(lines) => { setScript(lines); setMode("script"); }} scriptLines={script}
          onActiveChange={setLiveActive} />
      )}

      {/* takes log */}
      <PlaygroundTakeLog
        takes={takes} busy={busy} still={still}
        reviewSel={reviewSel} reviewBusy={reviewBusy} reviewUrl={reviewUrl} reviewErr={reviewErr}
        createReview={createReview}
        allowReperform={allowReperform} setAllowReperform={setAllowReperform}
        copy={copy} copied={copied} copyFailed={copyFailed}
        renderStatus={busy && (
          <RenderStatus key="rendering" startedAt={startedAt} etaSec={etaSec}
            estAudioSec={estAudioSec} etaBasisLabel={etaBasisLabel} noEtaLabel={noEtaLabel}
            streamedSec={streamedSec} queued={queued} inFlight={inFlight}
            metricsUnavailable={metricsUnavailable} healthStale={healthStale} still={still} />
        )}
        card={{
          characters, charName, still,
          playingId, paused, playhead, toggle, stop, seekTo,
          reviewSel, setReviewSel, shares, copied, copyFailed,
          onShare: share, onReuse: reuseTake,
          punchFor, setPunchFor, codeFor, setCodeFor, onRemove: removeTake,
          onCommitPunch: commitPunch, onStorageError: setStorageErr,
          engineBusy: busy,
        }}
      />
    </div>
  );
}
