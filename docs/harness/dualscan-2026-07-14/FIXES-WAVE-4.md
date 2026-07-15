# Dual-scan Fix Wave 4 — Resource leaks / deadlock / timeouts / recovery

> 5 commits, 6 findings closed (1 high, 5 medium).
> Gates: web `tsc` 0 / `next build` PASS; Python `py_compile` OK, ingest tests 27/27, `test_replicas` 17/17.

## Commits

| # | Commit | Finding | Severity | File(s) |
|---|---|---|---|---|
| 1 | `6e7d122` | export_stems stderr-pipe deadlock | high | `service/ingest.py` |
| 2 | `e731af7` | ffmpeg mp3-encode has no timeout | medium | `service/engine.py` |
| 3 | `477ba85` | blob-URL leaks (preview + TakeCard) | medium ×2 | `voices/_data/characters.ts`, `t/[id]/TakeCard.tsx` |
| 4 | `3d2f04b` | read/SSR fetches have no timeout | medium | `lib/backend.ts` + 5 read routes/pages |
| 5 | `8ca0756` | no cancel while cloning/rendering | medium | `variants/HeroMicDemo.tsx` |

## What was fixed

1. **Commit stderr-pipe deadlock** — `commit()` drained only stdout and read stderr once after the loop; the torch/pocket_tts child could fill the ~64 KB stderr buffer and wedge both sides forever. stderr now drains on a daemon thread (still captured for the failure message). **Ingest tests 27/27 exercise this path.**
2. **ffmpeg mp3-encode timeout** — `wav_bytes_to_mp3` ran `subprocess.run` with no `timeout`; a wedged ffmpeg pinned the worker thread with no escape. Added `timeout=60` → clean `RuntimeError`.
3. **Blob-URL leaks** — `useVoicePreview` never revoked prior preview URLs (one decoded-wav blob per preview, whole session); `TakeCard` minted its URL after the unmount cleanup ran, leaking on tab-switch-mid-fetch. Both now revoke (ref-tracked in preview; in the `!alive` abort path in TakeCard).
4. **Read/SSR timeout** — the GET `/api/takes/[id]`(+`/audio`) proxies and the SSR `loadTake`/`loadReview`/embed loaders had no `signal`; a stalled backend pinned the handler until the platform hard-timeout. Shared `READ_TIMEOUT_MS` (15s) `AbortSignal.timeout` on all five; the abort falls into the existing 503/`notFound` branch.
5. **Hero-demo cancel** — the cloning/rendering states had no cancel and no `AbortController`, so a hung backend trapped the visitor for ~5 min. Added an `AbortController` on both fetches + a Cancel button; a user abort is distinguished from a failure so it returns quietly to idle, and the throwaway character is still cleaned up.

## Verification

| Gate | Result |
|---|---|
| web `tsc --noEmit` | 0 errors |
| web `next build` | PASS |
| `test_ingest_lifecycle` + `test_ingest_pipeline` | 27/27 |
| `test_replicas` | 17/17 |
| `py_compile` (ingest/engine) | OK |

The ingest tests exercise the commit path (they stub `export_stems`), so the stderr-drain change is covered. `engine.py` still can't import without torch → `py_compile` + reasoning for the ffmpeg-timeout change. Web changes fully `tsc`+`build` gated; the leak/timeout UI behavior (revocations, abort-on-cancel) has no automated coverage — eyeball/e2e would confirm.

## Patterns established (catalogue items 14–17)

14. **Never leave a second pipe undrained across a long-lived child.** stdout+stderr both `PIPE` with only one reader deadlocks when the other fills (~64 KB). Drain concurrently (thread) or merge streams. (ingest)
15. **Bound every external process/network call with a timeout.** `subprocess.run`/`fetch` with no timeout can pin a worker/handler indefinitely; a wall-clock ceiling mirrors the request-timeout philosophy. (ffmpeg, read fetches)
16. **Revoke every object URL you mint — and watch the unmount-mid-fetch window.** `createObjectURL` retains the blob until `revokeObjectURL`; a URL minted after the cleanup already ran (async resolving post-unmount) leaks, so revoke in the abort path too. (preview, TakeCard)
17. **Give the user an escape from any multi-second op.** A busy state with no cancel + fetches with no `AbortController` is a multi-minute dead-end on a stalled backend. (hero demo)

## Repo gotcha discovered

`.gitignore` has `takes/` and `reviews/` (runtime data dirs), which also match the tracked route dir `web/app/api/takes/`. `git add web/app/api/takes/...` prints an "ignored" hint and **returns non-zero** even though the files are tracked — this breaks `git add … && git commit` chains. Stage those paths separately (they still stage) or `git add -f`.

## Deferred — ingest commit/GC lifecycle (needs a focused pass)

Three ingest findings were left for a dedicated, ideally Linux-tested pass — they change commit/GC *semantics* and carry data-consent risk, not the mechanical leak/timeout shape of this wave:
- **svc-ingest-pipeline #2 (high)** — mid-batch failure/cancel orphans already-cloned, consent-stamped voices (needs rollback-or-report-partial design).
- **svc-ingest-pipeline #3 (high)** — GC expires jobs by creation age with no status check, deleting stems mid-review (needs a `last_touched`/active-state guard).
- **svc-ingest-pipeline #4 (medium)** — empty-plan commit reports success cloning nothing (should 422 with skip reasons).

## What remains (per INDEX)

Waves 5–9 open: persistence/atomic-writes (keys.py + demand.json — same `os.replace` pattern), money-truth (fully web-verifiable), web UX contract (fully web-verifiable), test integrity, dead-code/duplication. Plus the deferred ingest-lifecycle trio above, and the deferred keys.py event-loop caching (svc-synthesis-api #1) for a perf pass.
