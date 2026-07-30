# Batch 2 — "The Living Stage" — SHIPPED

> 5 features, 5 parallel Opus builders + orchestrator integration, 7 commits on
> `vibeman/moonshot-batch-1` (continuing the batch-1 branch).
> Gates: service 55 modules / 1063 tests / 0 fail (batch-1 876 → +187);
> web tsc clean, next build PASS, vitest 466/467 (the 1 = the same pre-existing
> PlaygroundConsole load flake tracked since batch 1).

## Commits
| Commit | Feature |
|---|---|
| `aff4afb` | (docs) DESIGN-BATCH-2 |
| `f45d626` | Conversation Gym — replayable voice-agent CI (replay/compare/suites/CLI + /v1/convai/replay) |
| `0e8df7b` | Polyglot Turn (dialog/piper half) — TurnPart-as-str shim, directive grammar, LanguageTracker, script override, piper.prewarm |
| `e427225` | Conversation core — ZERO-GAP flags (partial decode / speculate / openers / echo suppression, default OFF, byte-identical off) + POLYGLOT convai wiring H1–H14 (+_stamp deviation) |
| `0ab3aaa` | Table Read — Live mode (_live/ module + convai proxies; turns become Takes and ScriptLines) |
| (next) | Punch-in — TakeTimeline, splice kernel, retake variants, edits provenance + Live mount |
| (last) | integration — gym router in app.py + batch-2 reports |

## Orchestration notes
- convai.py had ONE owner (ZERO-GAP); POLYGLOT's convai patch was applied by POLYGLOT itself
  in a second authorized pass after ZERO-GAP landed — its socket test caught a real
  concurrency defect in its own written patch (language read at render-time vs direct-time).
- TABLE-READ's "no-LLM rehearsal" need was relayed to POLYGLOT mid-flight (script override) —
  cross-builder requirement closed within the batch.
- PlaygroundConsole had ONE owner (PUNCH-IN); TABLE-READ's Live mount was a 10-line diff
  applied by the orchestrator after both landed (tsc + playground suite verified).
- GYM's router wired into app.py by the orchestrator under the convai scope.

## Deferred
- Gym: synthesized adversarial callers, listening-coverage report.
- Zero-gap: adaptive onset aggressiveness (needs echo reference burn-in).
- Polyglot: emotion→Pocket voice-variant mapping (registry question), packs carrying language matrices.
- Table Read: call-master (aligned user/agent WAV pair) download; agent-create endpoint.
- Punch-in: word-region UI (widen-to-clause design pass), splice-take rtf calibration.
- Cross-batch: merge `_live/pcm.ts::encodeWav` with `lib/wavEncode.ts` header writer.
- Deployment: CONVAI_PUBLIC_URL for proxied deployments (named in the transport refusal).

## Known issues
- Pre-existing PlaygroundConsole "keyed backend/unkeyed studio" test is load-flaky (red in
  most full-suite runs, green standalone; predates the campaign, `a854091`). Candidate for a
  dedicated stabilization fix — tracked, not touched in-batch.
- `test_longform.test_n_segments_occupy_n_workers_concurrently` similarly load-sensitive
  (one occurrence, passes standalone).
