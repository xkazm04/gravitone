# Batch 7 — "The Deferred Frontier" — SHIPPED

> 5 features from the deferred pool of ACCEPTED moonshots (no new scope), 5 parallel Opus
> builders + orchestrator integration, 6 commits on `vibeman/moonshot-batch-7` (off the
> merged main `802eff6`). Gates: service 75 modules / **1786 tests / 0 fail** (batch-6
> 1605 → +181); web tsc clean, next build PASS, vitest **915/915**; build client 23/23.

## Commits
| Commit | Feature |
|---|---|
| `37930ce` | (docs, pre-merge) DESIGN-BATCH-7 |
| `25f19a3` | NARRATE — /v1/narrate + bake-narration + narrate.js embed |
| `8cd15fb` | LOCKFILE — gravitone.lock/1, deterministic build zips, gravitone-build.mjs CLI |
| `a00d906` | LIMITER — ratelimit.py, demo budgets (hero-demo debt closed), opt-in public re-perform |
| `abf09b9` | AUTOFILL — derive autofill + A/B transfer-quality gate + packs provenance fix |
| `93352da` | LANES — ScriptScore stacked lanes + /t TakeScore + reports |

## Orchestrator integration performed
- app.py: narrate router; ratelimit imports + demo budgets on the TTS route/voices router;
  `_speak_for_take` provider handed to takes (the takes-cannot-import-app seam);
  ScriptScore console mount; composed /t page mount (TakeScore + RePerform + Provenance);
  /api/narrate/[id] proxy route.
- Cross-cutting fix: app-wired demo budgets 429'd heavy suites (one fake client address) —
  `GRAVITONE_RATELIMIT_TEST_BYPASS` set by the test package, checked per-request; the two
  budget-proof tests (test_ratelimit dependency suite, takes reperform budget) re-arm it
  for their own duration. Found by AUTOFILL's gate run; fixed at the root, not per-suite.

## Notable
- AUTOFILL confirmed and fixed a real packs bug: origin/derived_from/fidelity/prosody were
  dropped on export — a derived voice could have arrived at another install as "recorded"
  (consent laundering). Now travels both ways, guarded by test.
- LOCKFILE zips are byte-identical for identical builds (fixed epoch, ordered members).
- NARRATE's content_hash is golden-pinned against the web implementation on both sides.
- LANES: share-page score deliberately has no seek (TakeCard owns its audio element
  privately) — click reveals words instead; honest over convenient.

## Deferred (still open after batch 7)
- Narrate: /v1/narrate for third-party pages needs NARRATE_ALLOW_HOSTS config + a
  hosted-embed story; viseme/caption tracks.
- Lockfile: pooled/S3 store; the GitHub Action as a published action.
- Algebra: character blending; demand-autofill scheduling (currently manual tool).
- Fabric fan-out, local browser engine, and the Arm-box activation items (user debts).
