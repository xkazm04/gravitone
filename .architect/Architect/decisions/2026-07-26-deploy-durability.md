---
date: 2026-07-26
slug: deploy-durability
status: in-progress
type: weak-pattern
reach: "Dockerfile + bootstrap.sh + helm deployment + config.py + app.py health + deploy/README"
risk: 2
effort: m
payoff: 4
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# The shipped deploy config defeats the durability design

## Context
`ingest_api` implements careful durability: per-job workdir, `state.json`
mirror, rehydrate-on-restart, TTL GC. In the shipped topology none of it
works:
1. `INGEST_WORK_DIR` defaults inside the repo tree and is **not** a Docker
   volume or a helm mount (only `/app/voices` is) — every container restart
   drops the job store, making rehydrate dead code.
2. `/health` never reflected the drain, so a draining pod stayed in the k8s
   Endpoints list while 503-ing every submit.
3. Three uncoordinated timeouts: `request_timeout_s=120`, a hard-coded 10s
   `stop(drain_timeout_s)`, and `docker stop`'s 10s default / k8s' 30s — the
   orchestrator SIGKILLs mid-drain.
4. Ingest is silently single-replica-only: `JOBS` is per-process and only
   rehydrated at startup, so under `SO_REUSEPORT` a follow-up poll can land on
   a replica that 404s the job. Nothing documented this.

## Decision
- Dockerfile: `INGEST_WORK_DIR=/app/ingest_jobs`, `mkdir` + `VOLUME`; helm gets
  an `ingest-jobs` mount (emptyDir — deliberately per-pod, matching the
  replica-affine reality); bootstrap mounts a named volume.
- `TtsEngine.draining` property (no reaching into `_stopping`) and `/health`
  returns 503 `{"status":"draining"}` — liveness stays TCP so failing readiness
  doesn't kill the pod mid-drain.
- `Settings.drain_timeout_s` (default 20s), passed to `ENGINE.stop`, with the
  ordering rule documented at the definition; `docker stop -t 30` +
  `TimeoutStopSec=40` in bootstrap; `terminationGracePeriodSeconds: 45` in helm.
- `deploy/README.md` gains a "Shutdown budget" table and an "Ingest is
  replica-affine" section stating the constraint and that synthesis is
  unaffected (and that the registry is now safe either way — see
  [[2026-07-26-cross-process-registry]]).

## Consequences
Positive: durability actually durable; drains complete; the single-replica
ingest constraint is written down instead of discovered in production.
Negative/risks: emptyDir means ingest jobs still don't survive pod
*replacement* (only container restart) — correct given jobs are memory-affine;
a PVC would imply cross-replica sharing that does not exist. Longer grace
periods slow rolling deploys by design.
Mitigations: three tests on the draining health contract.

## Rollout
1. draining property + /health + drain_timeout_s + tests — suite (209 OK). ✅
2. Dockerfile / bootstrap / helm / README — no runtime gate available. ✅

## Acceptance criteria
- `/health` 503s with `status: draining` during shutdown. ✅ test
- Drain budget configurable and below every stop grace. ✅ (20 < 30/45)
- Ingest workdir mounted in all three deploy paths. ✅
- Replica-affinity documented. ✅

## Regression checklist
- [x] Suite green (209).
- [ ] `docker build` + `helm template` — UNVERIFIED (no Docker/helm on this box; YAML and Dockerfile edits are syntax-reviewed only).
- [ ] Real drain under load — UNVERIFIED (no runtime).
