# REPORT — PUNCH-IN (Punch-in timeline), Batch 2

> Saved by the orchestrator from the builder's inline report.

**Status: complete.** tsc clean; full vitest 467/467 green, 39 files (+70 tests; the
PlaygroundConsole flake did not appear; its file passes standalone 26/26).

Files — new: `web/lib/wavEncode.ts`(+test), `_variants/TakeTimeline.tsx`(+test),
`_variants/PunchIn.tsx`, `_variants/variantStore.ts`, `web/app/api/stt/route.ts`(+test).
Edited: `shared.ts` (D5 TakeEdits v1 + readEdits/appendEdit + segmentRegions/
scaleSegmentSeconds), `engine.ts` (decodePcm, spliceRegion, transcribeWords),
`useAudioPlayer.ts` (seekTo + pending-seek on loadedmetadata), `TakeCode.tsx` (base call +
patch calls), `PlaygroundConsole.tsx` (one `⌗ timeline` button, <PunchIn>, commitPunch,
punched chip), `playgroundDb.ts` (v3 + VARIANTS_STORE, schema only). `takeStore.ts`
untouched — `edits` persists through its existing spread; legacy records pinned by test.

Hooks: none. Console mode-switch area untouched; TABLE-READ's mount diff unaffected.

Deferred: word-region UI (step 4) — `/api/stt` route + `transcribeWords` shipped and tested,
but word-aligned boundaries contradict the binding "snap to segment edges" rule and need a
widen-to-clause design pass. Splice takes carry `rtf: 0`/no timingVersion so a one-segment
render never calibrates the whole-take estimate.
