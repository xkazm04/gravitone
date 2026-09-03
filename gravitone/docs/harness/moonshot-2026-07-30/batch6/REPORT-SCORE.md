# REPORT — SCORE (Score View), Batch 6

> Saved by the orchestrator from the builder's inline report. Mount diff applied by the
> orchestrator.

**Status: complete.** tsc clean; 127 tests across own files; full suite 800/801 (the 1 =
the tracked PlaygroundConsole load flake, untouched file).

Files (new except shared.ts, additive only):
- `shared.ts` — ScoreRegion, parseTags/toTags, regionProblem, normalizeRegions,
  transformRegions. No collision with PUNCH-IN (its Region/TakeEdits untouched, tests green).
- `components/ui/Track.tsx`, `Region.tsx` (+23 tests)
- `_variants/ScoreEditor.tsx` (+22), `score.test.ts` (55)

UX decisions: baseline = absence of a region (round-trip stays a fixed point); the grammar
does not nest → overlaps refused by name; **real asymmetry found**: `normalize_emotion`
allows digits but the tag regex does not, so a slot like `mode2` is legal but unaddressable
by tags — refused out loud, not dropped. Interior pure insertion grows a region (cannot
drift); any deletion/replacement touching a region clears it with a named live-region
notice; ambiguous append stays outside. Region keyed by index — offset keys dropped
keyboard focus mid-nudge (fixed, tested).

Mount (applied): solo-mode collapsible "score" details block under the composer,
<ScoreEditor value/onChange/characterId/expr/available/scale>, 8 lines.

Hooks: none. Multi-lane ScriptLine stacking deliberately skipped (would not ship an
unmounted component); Track + Region are domain-free and ready for it.
