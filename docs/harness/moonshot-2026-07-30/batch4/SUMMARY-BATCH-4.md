# Batch 4 — "The Platform Plane" — SHIPPED

> 5 features, 5 parallel Opus builders + orchestrator integration, 7 commits on
> `vibeman/moonshot-batch-1`. Gates: service 62 modules / 1288 tests / 0 fail
> (batch-3 1193 → +95); web tsc clean, next build PASS, vitest **641/641 fully green**;
> MCP bridge `node --test` 32/32.
>
> Mid-batch incident: the weekly API limit killed BUILD and AUDIBLE mid-flight; both were
> resumed from their own transcripts after reset and completed cleanly — partial trees held.

## Commits
| Commit | Feature |
|---|---|
| `0f83a66` | (docs) DESIGN-BATCH-4 |
| `cd149f6` | Speech Engine Plane — capability manifests, adapters, conformance kit, /v1/engines |
| `408fd87` | Speech as Build Artifact — DIGEST LAW, X-Speech-Digest/ETag/304, /v1/audio/{digest}, /v1/build(+plan) |
| `739dd20` | Key-as-Handshake — typed capability table, key manifest, .well-known, agents tab, zero-dep MCP bridge |
| `0a19c27` | Audible Docs — narratable registry + NarrationDock (opt-in, cached, AudioBus-wired) |
| `5e1d498` | Deployment Compiler — cert → deployment-plan.json → helm-values/compose/bootstrap |
| (last) | batch-4 reports + summary |

## Orchestrator integration performed
- Relayed ENGINE-PLANE's router include + set_pool_provider to BUILD (the app.py owner)
  mid-flight — landed inside BUILD's commit.
- `build_store/` → .gitignore (outside builder ownership).
- ETag + X-Speech-Digest mirrored into web/lib/serviceHeaders.ts (drift gate caught it —
  third time the parity test has done its job this campaign).

## Notable
- AUDIBLE caught invisible control bytes corrupting a hash template (identical-looking
  strings hashed differently) — now an explicit separator via String.fromCharCode(31).
- BUILD proved plain-TTS and build-line digests equal — the property that makes the
  lockfile vision coherent.
- COMPILER refuses to plan from failing/predicted-only certs; no-plan bootstrap output is
  byte-identical to pre-batch.

## Deferred
- Engine plane: full request-path routing through the protocol; third engine; ENGINES=
  policy; out-of-tree entry-point adapters.
- Build: gravitone.lock emission, zip delivery, CLI/GitHub Action, pooled/S3 store.
- Handshake: (none — F3 complete).
- Audible: build-time baking, POST /v1/narrate, embeddable narrate.js.
- Compiler: on-boot probe path for unmeasured boxes; role-scoped image pipelines in CI.
