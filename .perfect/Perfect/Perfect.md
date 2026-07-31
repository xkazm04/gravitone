# Perfect — Gravitone

**Mission**: session after session, move Gravitone (Arm-native CPU-only expressive TTS: FastAPI service + Next.js studio) measurably closer to the best product it can be. Fable directs, Opus builds, this vault remembers.

**Pool**: 0/10 — round 8 COMPLETE, 10/10 shipped (rounds 1-8: 84/84 accepted directions shipped, zero dropped)
**Cursor**: round-9 propose → free: Voice Cloning & Ingest (8), Concurrency Engine (8), Voice Creation Studio (7.5), Speech Synthesis API (8.5), TTS Playground (8), Voice & Emotion Library (7), Load Testing (6), App Shell (6). API Key Management + Character & Voice Management on cooldown until round 10.
**Repo drift since round 3**: `/architect` run 2026-07-26 landed 15+ robustness commits (`21dab69` → `4413dda`) — proxy error contract, sanitized 500s, event-loop offload, cross-process file locks, ingest teardown, web async hooks, web test runner. Robustness headroom in service + web is materially lower than the round-1 scores assumed.

Round-3 pool: show-consent-provenance · one-data-layer · right-sized-fetches · firstclass-custom-emotions · demand-driven-queue (Character Mgmt) | benchmark-real-replicas · streaming-ttfb · comparable-benchmark-results · honest-benchmark-accounting (Load Testing) | truth-sync-copy · working-ctas · lighter-shell · mobile-nav (Landing). Rejected: one-command-certification, landing-share-card.
**Shipped total**: 84 directions across 8 rounds
**Last session**: [[sessions/2026-07-29]] (round 8) · previous [[sessions/2026-07-28-3]] (round 6)

## Queue (opportunity-ranked, refreshed at proposal time)

| # | Context | Group | Opp | Cooldown |
|---|---------|-------|-----|----------|
| 1 | Voice Cloning & Ingest Pipeline | TTS Service Core | 8 | — (round-5 cursor) |
| 2 | Concurrency Engine & Metrics | TTS Service Core | 8 | — (see note: engine.py changed under it this round) |
| 3 | Voice Creation Studio | Web Studio | 7.5 | — |
| 4 | Voice & Emotion Library | TTS Service Core | 7 | — |
| 5 | Character & Voice Management | Web Studio | 6.5 | **round 8** (proposed 2026-07-29) |
| 6 | Load Testing & Benchmarks | Performance & Deployment | 6 | — |
| 7 | App Shell & Landing | Design System & Brand | 6 | — |
| 8 | Speech Synthesis API | TTS Service Core | 8.5 | — |
| 9 | TTS Playground | Web Studio | 8 | — |
| 10 | API Key Management | Web Studio | 5→**6.5** | **round 8** (proposed 2026-07-29) |
| 11 | Packaging & Deployment | Performance & Deployment | 5 | — |
| 12 | Emotion Glyph Art | Design System & Brand | 5 | — |
| 13 | Auth & Profile | Web Studio | 4 | — |
| 14 | UI Design System | Design System & Brand | 4 | — |

Scoring lens: hackathon-facing Arm TTS product — demo impact, API polish, and the Arm performance story score high; internal chrome scores low.

## Known drift

`context-map.json` (2026-07-10) predates recent commits: `service/` now also holds `auth.py`, `certify.py`, `demand.py`, `packs.py`, `takes.py` (reviews/takes + client-approval features) that no context owns yet. Scouts should surface these; refresh the map when a context claims them.

**New in round 4, unowned by the map**: `service/cache.py` (synthesis LRU + single-flight), `web/lib/playgroundDb.ts`, `web/lib/composerStore.ts`, `benchmark_arm_ab.sh`, and tests `test_longform.py` / `test_cache.py` / `test_arm_tuning.py` / `composerStore.test.ts` / `takeStore.test.ts` / `useHealthPoll.test.ts` / `characters.test.ts` / `shared.test.ts` / `EmotionPicker.test.tsx`. `web/lib/useMounted.ts` now also exports `useClientReady`.

## Round-5 candidates already banked (no scout needed)

- ~~**API Key Management (web)**~~ SHIPPED round 8 as [[revoke-not-destroy]] (1796604): the round-4 `POST /v1/keys/{kid}/revoke` endpoint has NO studio affordance — `web/app/api/keys/[id]/route.ts` proxies DELETE only, so the studio still offers only the destructive option. This is why the context's score went 5 → 6.5.
- **Speech Synthesis API (round 6)**: `/v1/speak` and `/v1/performance` still report `X-Synth-Seconds` as the SUM of concurrently-run segments — a duration that never elapsed and an RTF that never was. Round 4 fixed exactly this on the drop-in route; the same fix applies. Also: those two routes have no `output_format` (always WAV), and they plus `/stream` are uncached.
- **Arm box, 60 seconds, settles an open question**: POST the loadtest fixture with `TTS_MAX_TOKENS=50` then `500` and compare `X-Audio-Seconds`. Identical ⇒ 50 is not an output cap. Longer at 500 ⇒ it IS one, it has been silently truncating long single-job requests, and the default must be raised independently of segmentation. Also run `bash benchmark_arm_ab.sh` — the Arm tuning shipped unmeasured by design.
- **Deployment posture question for the user**: with `TTS_API_KEY` empty the whole service including `/v1/keys` admin is open. Managed-key revocation is now real, but a deploy that forgets the env var gets none of it.
- Small, cheap: `engine.available_permits()`'s docstring forbids reaching into `Semaphore._value` and then does exactly that; `fake_engine.capacity` models in-flight only while real admission is in-flight + queued (so backpressure tests are optimistic); the three new env vars (`TTS_CHUNK_CHARS`, `TTS_STREAM_DEADLINE_S`/`TTS_STREAM_WINDOW`, `TTS_CACHE_BYTES`) are documented in `config.py` but not the README env table; `SecretReveal.tsx` + `GuidedRecorder.tsx` still hand-roll the client-ready flag.

## Round 8 — all shipped 2026-07-29 (f580846 → 9613db6), 12 commits

API Key Management:
- [[revoke-not-destroy]] → **1796604** · [[secret-not-losable]] → **d66ac19**
- [[deployment-posture-truth]] → **f2752a2** · [[compat-check-real-path]] → **41cfd91** · [[keys-surface-tested]] → **69c4d8e**

Character & Voice Management:
- [[slug-truth-in-ui]] → **9ea5270** · [[failure-not-absence]] → **b4c39be**
- [[duplicate-visible-deletable]] → **f7e1ee5** · [[collision-gets-an-answer]] → **048a20f** (+ Director repair **f04a3c2**)
- [[destroy-deliberately]] → **9613db6**

Director commits: **f04a3c2** (repair of my own bad test-file merge) · **6ea3ac0** (auth scope docstring, stale since round 4).

**The headline held up: the studio's "revoke" button destroyed the key.** Verified at `KeysLedger.tsx:115` before briefing — real revoke had been unreachable since round 4 and was flagged in four consecutive wraps. Both contexts were the same shape: a UI that had not caught up with, and in places contradicted, a backend rewritten under it.

**The round's best find was not on the slate.** Writing the keys surface's first tests turned up `useCopyFeedback` defaulting its target key to `""` — falsy — so **seven** surfaces never left the idle copy label and the "copy blocked" branch could not render at all. The hook's own test passed throughout: it asserted `not.toBeNull()`, which `""` satisfies. Teeth-checked by the Director both ways.

Gates at wrap: `compileall` clean · **540 service tests + 87 subtests** · `tsc --noEmit` clean · **273 web tests / 26 files** (191/18 at round start — +82). All worktrees and branches removed; only `main` remains.

## Round 7 — all shipped 2026-07-28 (a018556 → f580846, 12 commits)

Voice & Emotion Library:
- [[pack-import-path-safety]] → **2d16fd5** · [[builtin-name-collision]] → **d329aec**
- [[registry-never-silently-empty]] → **401a12a** · [[one-exporter-clone-path]] → **3707fb4**
- [[registry-write-invariants]] → **054a791**

TTS Playground:
- [[one-header-contract]] → **21a7064** · [[premium-format-in-console]] → **2400f6b** · [[proxy-streams-audio]] → **b69cc11**
- [[absent-is-not-empty]] → **2531a21** · [[console-surfaces-tested]] → **205054a** (+ Director integration fix **a854091**)
- Director flake fix **f580846**

**Two verified defects led this round**: a pack import could write OUTSIDE `voices/` with attacker-chosen bytes (signing off by default), and a cloned character named after a built-in — mary, paul, george, anna — was silently erased from the roster after a 201 Created. Both confirmed by the Director before proposing and re-verified against the merged code.

Gates at wrap: `compileall` clean · **540 service tests + 87 subtests** (469 at round start) · `tsc --noEmit` clean · **191 web tests / 18 files** (139 at round start).

## Round 6 — all shipped 2026-07-28 (3bb024d → a018556, 12 commits)

Speech Synthesis API:
- [[browser-usable-api]] → **0e4d82f** · [[private-surface-not-published]] → **32cd96b** (+ Director KEDA fix **005f574**)
- [[honest-self-reported-numbers]] → **2b84ae1** · [[premium-route-batch-cap]] → **da365e5** (+ Director flake fix **a018556**) · [[premium-output-format]] → **70b7f63**

Voice Creation Studio:
- [[backend-truth-reaches-user]] → **463140d** · [[stop-saying-false-things]] → **10684c3**
- [[retry-not-failure]] → **8f1918e** (+ Director service fix **a58b37f**) · [[flow-state-truth]] → **86b77b6**

Rejected at the gate: [[scan-cost-visible]] — the fourth cost/telemetry direction declined; now a standing taste rule in config.md.

Gates at wrap: `compileall` clean · **469 service tests + 72 subtests** (415 at round start) · `tsc --noEmit` clean · **139 web tests / 14 files** (90 at round start).

## Round 5 — all shipped 2026-07-28 (11e3465 → 3bb024d, 12 commits)

Concurrency Engine & Metrics:
- [[benchmark-measures-engine]] → **a1e2a16** · [[pool-truth-aggregation]] → **da5cd76**
- [[worker-death-is-visible]] → **718a790** · [[honest-admission-accounting]] → **f5f0e27**
- [[segmentation-earns-its-keep]] → **d9dd0d1**

Voice Cloning & Ingest:
- [[input-side-seeking]] → **ae12f52** · [[neutral-baseline-stem]] → **5de0b31** (+ Director **89769e0**)
- [[cancel-stops-the-spend]] → **af67850** · [[external-call-budget]] → **05021e9**
- [[sovereign-path-works]] → **585c816** (+ Director **3bb024d**)

**Two of the engine five were cleanup of round-4 regressions the Director shipped**: the synthesis cache silently turned the load test into a cache benchmark, and long-form segmentation claimed a parallelism the shipped single-worker topology cannot deliver.

Gates at wrap: `compileall` clean · **415 service tests + 28 subtests** (274 at round start) · `tsc --noEmit` clean · **76 web tests / 10 files** · web `next build` unaffected (no route changes).

## Round 4 — all shipped 2026-07-28 (4413dda → 11e3465)

Service lane (S1, S2 + Director):
1. [[parallel-longform-tts]] → **8c4389e** (+ Director-forced fix **2725d2a**)
2. [[stream-chunk-budget]] → **ac01955**
3. [[synthesis-cache]] → **917e012**
4. [[key-lifecycle-truth]] → **233314c**
5. [[arm-inference-pass]] → **10099c4** (+ Director doc fix **6f2d1b0**)

Web lane (W1 → W2 sequenced):
6. [[failure-truth-console]] → **3c47071**
7. [[meaningful-render-progress]] → **f23915d**
8. [[playground-load-path]] → **0077ade**
9. [[durable-iteration-loop]] → **ed18a56**
10. [[reachable-characters]] → **11e3465**

Gates on main at wrap: `compileall` clean · **274 service tests + 23 subtests** · `tsc --noEmit` clean · **76 web tests / 10 files** (was 29/4 at round start) · `next build` compiles + prerenders every route.

## Accepted pool — round 1 (all shipped, kept for history)

1. [[streaming-synthesis-endpoint]] — Speech Synthesis API · feature · M
2. [[elevenlabs-dropin-compat]] — Speech Synthesis API · ux · M
3. [[parallel-multisegment-synthesis]] — Speech Synthesis API · optimization · S
4. [[keys-error-hardening]] — Speech Synthesis API · robustness · S
5. [[consent-receipts]] — Voice Cloning & Ingest · feature · S
6. [[async-commit-cancel]] — Voice Cloning & Ingest · ux · M
7. [[parallel-label-commit]] — Voice Cloning & Ingest · optimization · M
8. [[durable-job-lifecycle]] — Voice Cloning & Ingest · robustness · M
9. [[one-true-clone-path]] — Voice Cloning & Ingest · wildcard · S
10. [[skip-abandoned-jobs]] — Concurrency Engine · optimization · S
11. [[graceful-drain-shutdown]] — Concurrency Engine · robustness · S
12. [[replica-native-mode]] — Concurrency Engine · wildcard · M

## Shipped ledger

Wave 1 — 2026-07-13 (base 8cc1365):
- streaming-synthesis-endpoint → d6d15bd
- parallel-multisegment-synthesis → 1f432df
- keys-error-hardening → f1aaf21 (+ 10b917d test .env pin, Director)
- durable-job-lifecycle → 60784d3
- async-commit-cancel → 0b6d6c4 (+ 337d2d2 cancel-dead-end fix, Director)
- consent-receipts → b972668

Wave 2 — 2026-07-13:
- skip-abandoned-jobs → b5bae02 (+28b68a0 stream-abandon, Director)
- graceful-drain-shutdown → 81ccb72
- replica-native-mode → d2e8dae (TTS_WORKERS default 2→1)
- parallel-label-commit → 0407009 (+87b5bf9 load-back verify, Director)
- one-true-clone-path → 9e3a15b

Wave 3 — 2026-07-13:
- elevenlabs-dropin-compat → ffced19

Round 1 total: 12/12 shipped, 17 commits (8cc1365 → ffced19), gates green throughout.

Round 2 wave 1 — 2026-07-13:
- create-flow-state-machine → 99313a6 · truthful-pipeline-feedback → 6bce07a · preview-poll-efficiency → de3ed28 (+ef488f6 Director)
- atomic-voice-registry → 42f1bb9 (+9fa3390 Director) · registry-read-cache → 4ab9b8c · nearest-emotion-fallback → 0537289
- honest-status-timing → 100e857 · durable-takes → ec88a5e (/api/tts kept — not an orphan) · performance-composer → 4fa426c

Round 2 wave 2 — 2026-07-13:
- api-clone-consent → f9a63c4

Round 2 total: 10/10 shipped, 13 commits (0dd67fc → f9a63c4), 119 service tests + tsc green.

Round 3 — 2026-07-13: 13/13 shipped (f9a63c4 → 0267e77), 161 service tests + tsc green.
- Landing: 157679b truth-sync · e10ca52 CTAs · c268ff8 lighter shell · edc0f28 mobile nav
- Char Mgmt: a073c9e one data layer · d0e58be right-sized fetches (+GET /v1/characters/{id}) · 2a0d832 consent/provenance UI · 1b836d1 first-class custom emotions · bf3a1ef demand queue
- Bench: 11d8d5f comparable results (schema v2) · 7057f88 real-replicas topology (+f215b57 Director non-Linux warning) · 38071dc streaming TTFB · 0267e77 honest accounting
