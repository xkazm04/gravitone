---
date: 2026-07-26
mode: scan
theme: error-handling
sub_agents_spawned: 4
findings_total: 8
findings_weak: 3
findings_strong: 2
findings_swap: 0
findings_struct_bug: 2
findings_convention_gap: 1
executed: [1, 2, 3, 4, 5, 6, S7, S8]
queued: []
dropped: []
reworked: []
adrs_written: ["stream-swallow", "error-taxonomy", "auth-coverage", "proxy-contract", "client-fetch-surface", "silent-failures", "codify-strong-patterns"]
commits: [ceeb6eb, 633bdbc, 85a0b59, 21dab69, e9ab0ce, 5345246]
branch: "(committed to main)"
---

# Architect scan — error-handling (2026-07-26)

First run of the adopted skill. Theme picked cold-vault by cross-cutting
surface. Story: the service speaks one clean `{"detail"}` error contract; each
layer above fragmented it (5 proxy dialects → 7 UI surfaces → silent holes).

## Sub-agent reports (summaries)
- **Service error map**: 53 excepts, 0 bare; engine/queue path excellent; no
  taxonomy module, dual 404 schema in ingest_api, no catch-all, unlogged swallows
  concentrated in the 5 logger-less files; worst line app.py:478. Smell 3.
- **Service↔proxy contract**: jsonError used 2/26; 5 dialects; tts 429→502;
  preferred 200-on-fail; plain-text 503 → user-visible SyntaxError; timeouts
  12/26 with 7 values. Smell 3.5. No secret/URL leakage (verified).
- **Web UI surfaces**: throwDetail exemplary but scoped to one module; 7 error
  mechanisms, amber/rose severity collision; 6 silent holes incl. useAuth
  forever-Loading; poller blind to transport failure. Smell 3.
- **Test coverage**: suite is failure-oriented (429/503/504/500/422/409 covered)
  but auth structurally untestable (env pin), packs/takes zero tests, invalid
  voice → 500. Smell 3. Cross-ref: docs/harness/dualscan-2026-07-14 partitioned
  similar territory.

## Findings & verdicts
All executed this session (user: "execute all now"). See ADRs. Validation:
service suite 164 → 188 tests OK; compileall clean; tsc clean throughout.
Unverified residue: live smoke of proxy routes + visual pass of swapped banners
(no local TTS runtime / no dev-server session) — flagged in ADRs.

## Strong patterns observed
- Engine job lifecycle discipline → codified (docs-claude)
- Honest failure surfaces → codified (docs-claude)

## Cross-references
- Perfect directions bordering this territory: [[keys-error-hardening]] (shipped, service keys), [[truthful-pipeline-feedback]] (shipped, server-reported honesty — this run added the transport-failure half), [[one-data-layer]] (shipped, built throwDetail this run generalized).
- Prior scan docs: gravitone/docs/harness/dualscan-2026-07-14/ (tests territory).
