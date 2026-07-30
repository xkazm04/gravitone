# Batch 3 — "Proof & Trust" — SHIPPED

> 5 features, 5 parallel Opus builders + orchestrator integration, 7 commits on
> `vibeman/moonshot-batch-1`. Gates: service 59 modules / 1193 tests / 0 fail
> (batch-2 1063 → +130); web tsc clean, next build PASS, vitest **527/527 — fully green**
> (even the tracked PlaygroundConsole flake passed this run).

## Commits
| Commit | Feature |
|---|---|
| `a47d0c9` | (docs) DESIGN-BATCH-3 |
| `59479fc` | SLO Capacity Contract — open-loop Poisson driver, SLO predicate, cert v3 capacity contract |
| `baad616` | Sealed Appliance — Dockerfile bake stages (fixes the ships-without-ears divergence), /v1/appliance manifest, airgap install, sealed.yml (authored, NOT run) |
| `4dd9c81` | Proving Ledger — measured posture, proven-vs-declared chips, prove-keys.mjs CI twin, service 403-vs-401 distinction |
| `0ed9aad` | Speaker Sign-Off — two-party consent, /s/[voiceId] public route, speaker dashboard, revocation flow |
| (next) | Verified Speech — with-timestamps route, verify=true|strict, verify.py, stt Word.confidence |
| (last) | batch-3 reports + summary |

## Orchestrator integration performed
- `service/auth.py` + `keys.py`: the clean 403 fix (key_recognized, constant-time discipline
  preserved; recognition does not bump last_used); `test_auth_distinction` tightened to PIN
  the new distinction (was pinning the gap).
- `service/stt.py`: `Word.confidence` (faster-whisper per-word probability) so VERIFIED's
  confidence floor is live on real boxes, not inert.
- `web/lib/serviceHeaders.ts`: mirrored the new X-Alignment-Cache + X-Fidelity-* headers
  (the drift-gate test caught this exactly as designed).
- `service/app.py`: appliance router wired under `admin` scope (fail-closed default).

## User actions required (not code)
1. **Deploy the Firestore rules** for `speakers/**` + the `users/{uid}/voices` get/update
   narrowing — block in `batch3/REPORT-SIGN-OFF.md`.
2. Sealed image: first real `docker buildx` on an Arm box + the sealed.yml run; model
   license review (whisper/CT2, sherpa) before redistributing baked images.

## Deferred
- Proving: service-side attestation storage (studio-side only for now).
- Sign-Off: .gravichar manifest carrying sign-off (packs), email invites.
- Verified: per-voice pronunciation lexicon, viseme/caption tracks, fit_duration_ms.
- SLO: saturation-curve fit + --probe predicted envelope; /benchmarks traffic-shape planner.
- Appliance: Deployment Compiler (M2) is batch 4; role-scoped images ride it.
