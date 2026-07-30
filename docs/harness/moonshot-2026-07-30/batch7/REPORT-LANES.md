# REPORT — LANES (Multi-lane Score + Share-page Score), Batch 7

> Saved by the orchestrator from the builder's inline report. Console mount applied by the
> orchestrator; /t page mount composed with LIMITER's diff.

**Status: complete.** tsc clean; own tests 24 (ScriptScore 14, TakeScore 10); full suite
855/856 (the 1 = the tracked PlaygroundConsole flake, file untouched, 26/26 alone). All
batch-6 score tests green.

Files: new `_variants/ScriptScore.tsx` (+14 tests); new `app/t/[id]/TakeScore.tsx` (+10);
additive `shared.ts` (characterHue = hueFor(id) hash); additive `Region.tsx` (spanText? —
a time rail must not say "characters 3 to 9").

UX: lanes derive regions per render → no drift possible (no transform needed). Lane =
roving arrow list; click delegates focus to the composer line. No-selection placement is
honest: "+ direct this whole line" then drag/nudge; overlaps refused by name. Inspector
only on the focused lane. TakeScore is read-only, placed in TIME with scaled seconds
(even-split labelled "order only"); NO seek — TakeCard owns its <audio> privately with no
exported seam, so click selects and reveals the words instead. Renders null without
segments/duration. Reduced motion honored (+ feature-detected scrollIntoView).

Mounts: PlaygroundConsole script-mode <details> with <ScriptScore> (applied);
/t/[id]/page.tsx <TakeScore take={take}/> after the TakeCard wrapper (composed with
LIMITER's RePerform placement).

Hooks: optional 1-liner — PlaygroundConsole:1241's rail dot could use characterHue
(length-based hue collides for equal-length ids).
