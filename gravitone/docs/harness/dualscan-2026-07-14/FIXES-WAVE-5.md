# Dual-scan Fix Wave 5 — Persistence / atomic-writes / state-integrity

> 4 commits, 4 findings closed (all high).
> Gates: web `tsc` 0 / `next build` PASS; Python `py_compile` OK, `test_keys` 4/4, `test_loadtest` 36/36, atomic-write + loadtest-counter proven by smoke tests.

## Commits

| # | Commit | Finding | Severity | File(s) |
|---|---|---|---|---|
| 1 | `47e1ce9` | api_keys.json non-atomic write erases all keys | high | `service/atomicio.py` (new), `service/keys.py` |
| 2 | `f471b89` | emotion_demand.json torn write wipes demand | high | `service/demand.py` |
| 3 | `07bfa8e` | successful synth miscounted as error | high | `service/loadtest.py` |
| 4 | `5414ccc` | profile Save hangs forever on failed write | high | `web/app/profile/page.tsx` |

## What was fixed

1. **Key-store atomic write** — `_save` wrote `api_keys.json` in place, so a crash mid-write left a truncated file; `_load` read that as `{}` and the next `create_key` overwrote it — permanently erasing every issued key (secrets are one-time; recovery = re-issue all). New `service/atomicio.py` (`atomic_write_text`: per-PID temp + `os.replace`, so multi-replica writes never collide or tear); `_save` uses it, and `_load` now **logs loudly** on a corrupt parse instead of silently zeroing.
2. **Demand-store atomic write** — `record_fallback`'s per-process lock doesn't exclude other replica processes, so concurrent `write_text`s could tear `emotion_demand.json`, and `_load` then returned `{}` — silently wiping the whole recording-queue signal. Now writes via `atomic_write_text` (worst case = a lost increment, the documented tradeoff, never total loss) + logs on corrupt.
3. **Loadtest counter** — `_one`'s ok-path parsed timing headers with `float()` inside the request try, so a 200 with a malformed `X-Realtime-Factor` raised into `except → errors += 1`, recording latency AND re-counting the success as an error — falsely tripping level degradation and corrupting the certified capacity knee. Added `_safe_float`; the success stays counted as ok. **Proven** by smoke (malformed-header 200 → errors 0, latency recorded once).
4. **Profile Save hang** — `save()` awaited `updateProfile` with no `try/catch/finally`, so a rejected Firestore write left the button stuck on "Saving…" forever with the edit silently lost. Wrapped in `try/catch/finally`: failure surfaces an error next to the button, `finally` always clears the saving state.

## Verification

| Gate | Result |
|---|---|
| web `tsc --noEmit` / `next build` | 0 errors / PASS |
| `service.tests.test_keys` (exercises `_save`/`_load`) | 4/4 |
| `service.tests.test_loadtest` (exercises `_one`) | 36/36 |
| `atomic_write_text` smoke | writes, reads back, no temp left ✓ |
| loadtest-counter smoke | malformed-header 200 → errors 0, lat=1 ✓ |
| `py_compile` (atomicio/keys/demand/loadtest) | OK |

Both changed service modules (`keys.py`, `demand.py`, `loadtest.py`) import cleanly **without torch**, so these fixes got real test runs — not just `py_compile`. This is the best-verified service wave so far.

## Patterns established (catalogue items 18–20)

18. **Durable single-file stores need atomic writes (temp + `os.replace`), never write-in-place.** An interrupted or interleaved write truncates the file; a reader then sees `{}` and a subsequent write erases the survivors. `os.replace` is atomic on POSIX and Windows. (keys, demand → shared `atomicio.py`)
19. **Corruption must be loud, never silently zeroed.** Returning `{}` on a `JSONDecodeError` converts a torn file into total silent data loss and lets the next write erase the recoverable file. Log (or preserve) instead. (keys, demand `_load`)
20. **Parse untrusted response fields defensively inside a shared try.** A `float()` on a header in the success branch can drop a 200 into the error path (double-count) — coerce with a safe default. (loadtest)

Plus a reinforcement of catalogue #5: **every `await` that can reject and holds UI state needs `try/finally`** to release it (profile Save).

## `atomicio.py` — reusable beyond this wave

The new `atomic_write_text` is the durability primitive the other single-file stores should adopt: `service/takes.py` (`create_take`/`create_review`/`pick_take`) and `service/voices.py` (`mutate_meta`'s `_meta.json` write) all still use plain `write_text`. None were flagged findings, but the voice-registry write in particular is the highest-value candidate for a future atomic-write sweep.

## What remains (per INDEX)

Waves 6–9 open: money-truth (fully web-verifiable), web UX contract (fully web-verifiable), test integrity, dead-code/duplication. Still deferred: the ingest commit/GC lifecycle trio (svc-ingest #2/#3/#4), keys.py event-loop caching (svc-synthesis #1), streaming errors swallowed (app.py), and the takes/voices atomic-write sweep noted above.
