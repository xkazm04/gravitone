# REPORT — WASM (In-Browser Engine seam), Batch 6

> Saved by the orchestrator from the builder's inline report.

**Status: H4 complete** — seam + probe + panel; all consumers refactored; no behaviour change.

Files:
- `web/lib/engineSeam.ts` (new): SpeechEngineClient (synthesize/capabilities), typed
  SynthesisRequest (solo | performance | voice), TakeAudio, EngineCaps, failure vocabulary
  (EngineDegraded + FallbackReason, EngineBusyError, isAbort), ServerEngine (all /api/speak,
  /api/performance, /api/tts fetch + header decoding moved verbatim), registry
  getEngine()/registerEngine().
- `web/lib/engineProbe.ts` (new): wasm/SIMD(byte-validated)/threads/WebGPU/storage/
  deviceMemory; tri-state ok true|false|null; capable/missing/unknown/notes (honest
  unknowns named — e.g. Safari quota).
- `web/app/benchmarks/LocalEnginePanel.tsx` (new) + mounted in BenchmarksView under
  "Where the synthesis runs".
- `engine.ts`: speak/perform via the seam; browser-voice fallback stays playground policy;
  EngineBusyError/isAbort/FallbackReason re-exported so no importer changed.
  `HeroMicDemo.tsx`: /api/tts fetch → getEngine().synthesize({kind:"voice"}).

Tests: engineSeam (30) + engineProbe (19) + LocalEnginePanel (9); engine.test.ts UNMODIFIED
and green; tsc clean; full vitest 59 files / 800 tests pass (a first run had 17 ScoreEditor
fails — SCORE's file mid-flight, green on re-run).

Design note: no `fragment` request kind — a punch-in fragment is byte-identical on the wire
to a solo request pinned to wav; covered by a dedicated conformance test instead of a
discriminant that changes nothing.

Hooks: none.
