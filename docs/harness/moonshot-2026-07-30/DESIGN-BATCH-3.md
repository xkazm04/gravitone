# Batch 3 Design — "Proof & Trust"

> Five features, one story: **everything the product claims becomes something it can prove.**
> Keys prove their privileges (Proving Ledger), consent becomes a two-party signed protocol
> (Speaker Sign-Off), synthesis proves it said the words (Verified Speech), capacity becomes
> an SLO contract (SLO Capacity Contract), and the deployable artifact proves completeness
> and zero egress (Sealed Appliance).
>
> Branch: `vibeman/moonshot-batch-1` (continues). Builders NEVER run git. Orchestrator
> integrates + commits. Batch-1/2 UX vocabulary binding: named facts over scores,
> proven-vs-declared as solid-vs-outlined, absent=invisible, advisory-never-blocking,
> TakePlayer for playback, tokens only.

## 1. UX narrative
The keys page stops guessing: every scope chip is either **proven** (solid, timestamped) or
**declared-only** (outlined); an open deployment becomes the loudest thing on the page. A
cloned voice can carry a **speaker-signed** badge — the strongest tier the vault has — and
every clone can invite its human. The API returns receipts: word timelines and fidelity
verdicts. The certificate stops describing a lab ramp and starts promising "N concurrent
listeners at p95 ≤ SLO". The Docker artifact finally contains the whole product.

## 2. Shared contracts

### E1. Bare fetch (web/lib/backend.ts, owned by PROVING)
`backendFetch(path, { bare: true, ... })` — attaches NO key. Server routes only. Existing
call sites unchanged.

### E2. Probe verdict (owned by PROVING)
`{ scope, expected: "allowed"|"refused", observed: "allowed"|"refused"|"unreachable",
verdict: "proven"|"correctly-refused"|"granted-but-refused"|"REFUSED-SCOPE-SERVED" }[]`
plus posture `enforced | open | unreachable` (replaces `unknown`). Probes are capped,
serialized, never run on page load (mint/rotate + explicit button only). Every proven chip
carries the probe timestamp. Negative-probe wording is an alert, not a shrug.

### E3. Sign-off record (web, owned by SIGN-OFF)
`VaultEntry.consent.signoff: { status: "self"|"pending"|"signed"|"declined", speakerUid?,
speakerEmail?, phrase, scope?: { purpose?, expiresAt?, exclusions?: string[] }, signedAt? }`
Mirror at `speakers/{speakerUid}/consents/{voiceId}`. Client-enforced v1 — the copy must say
so plainly (no overclaim). Self-attested stays the default; sign-off is the upgrade badge.

### E4. Verified synthesis (service, owned by VERIFIED)
- `POST /v1/text-to-speech/{voice_id}/with-timestamps` — ElevenLabs-compatible JSON
  (base64 audio + alignment) built by feeding the finished WAV through `stt.transcribe_pcm`;
  synthesis path unchanged; alignment cached beside audio in SYNTH_CACHE.
- `?verify=true` on the normal route → `X-Fidelity-Score` (normalized word match, high-
  confidence words only) + `X-Fidelity-Deltas`. Opt-in; the default hot path byte-identical.
- Degrades exactly like convai when `stt.available()` is false: named 501/absent headers,
  never a crash. NO streaming-route verification.

### E5. Capacity contract (service, owned by SLO)
`workload.arrival_schedule(rate_rps, duration_s, seed)` + `corpus_sample(profile, seed)`
(pure, deterministic); open-loop `--arrival poisson --rate R --duration S` with a HARD
`--max-in-flight` circuit breaker; SLO predicate extends `level_degraded()`; certify gains
`sustains_slo` + capacity block and bumps to `gravitone-cert/3` (v2 comparison refused by
design, like the existing precedent).

### E6. Appliance manifest (service, owned by APPLIANCE)
`service/appliance.py` with its OWN APIRouter (`GET /v1/appliance`; orchestrator wires it):
reuse packs.py's canonical sha256(+HMAC) manifest pattern over
`{image_digest?, models: [{path, sha256, provenance}], locales, capabilities, sbom?}`.
Reads a baked `/opt/gravitone/models` layout when present; degrades to "unsealed" with the
missing pieces NAMED when absent (dev boxes).

## 3. File ownership (HARD)

| Agent | Owns | Must NOT touch |
|---|---|---|
| **PROVING** | `web/app/keys/**`, `web/app/api/keys/**`, `web/lib/backend.ts` (bare option only), `scripts/prove-keys.mjs` | `web/app/profile/**`, `web/lib/voiceVault.ts`, service/** (auth.py 401-vs-403 gap → report hook) |
| **SIGN-OFF** | `web/lib/voiceVault.ts`, `web/app/profile/**`, `web/app/s/**` (new), `web/components/ui/UserMenu.tsx` (badge only) | `web/app/keys/**`, `web/lib/backend.ts`, service/**, Firestore rules (document them in report) |
| **VERIFIED** | `service/app.py`, `service/verify.py` (new), their tests | `service/stt.py`, `service/loadtest.py`, `service/certify.py`, `service/appliance.py`, web/** |
| **SLO** | `service/workload.py` (new), `service/loadtest.py`, `service/certify.py`, their tests | `service/app.py`, `service/replicas.py`, Dockerfile/deploy/**, web/** |
| **APPLIANCE** | `Dockerfile`, `requirements.txt` (consistency only — no version churn), `deploy/**`, `service/appliance.py` (new), `.github/workflows/sealed.yml` (new), `scripts/airgap-install.sh` | `service/app.py` (router wired by orchestrator), `service/certify.py`, web/** |

app.py has ONE owner this batch: VERIFIED. APPLIANCE's `GET /v1/appliance` lives on its own
router; SLO touches loadtest/certify only.

## 4. Per-feature batch-3 scope

### PROVING — Proving Ledger (`api-key-management.md` M1, steps 1–3 + 5–6; step 4 lite)
Bare-fetch posture probe (401 ⇒ enforced, 200 ⇒ OPEN — loudest thing on the page);
secret+scope sweep with positive AND negative probes at mint/rotate in SecretReveal
(promote MigrationKit's single check); proven-vs-declared chips in KeysLedger (solid vs
outlined + probe timestamp); "re-prove" row action (secretless posture only); headless
`scripts/prove-keys.mjs` twin (JSON + non-zero exit on any REFUSED-SCOPE-SERVED row).
Attestation persistence: studio-side store (localStorage/Firestore per existing patterns) —
do NOT grow the service key model this batch. FIRST verify service 401-vs-403 distinction
with a live probe against a test client reading service/auth.py; if wrong-scope and no-key
are indistinguishable, scope the sweep to what IS provable and put the auth.py gap in your
report as an orchestrator hook. Probe requests must be cheap + side-effect-free (auth
failures happen before work; the tts positive probe uses a 1-word synth).

### SIGN-OFF — Speaker Sign-Off (`auth-profile.md` M2, steps 1–2 + 4–5; 3 basic; 6 deferred)
E3 shape + per-row badge/action in MyVoices ("request sign-off" → pending + phrase +
copyable link); public `/s/[voiceId]` page (mirror /t /r patterns: hear the voice, sign in
via existing signIn(), record the verification phrase with the guided-recorder component,
grant with purpose/expiry/exclusions); write to both vault row and `speakers/{uid}/consents`
mirror; "Voices of mine" panel on /profile (same component vocabulary as MyVoices, opposite
direction) with per-entry withdraw; withdraw → owner row flips "consent withdrawn — action
required" → existing DELETE + markRevoked path; expired/withdrawn render struck-through like
revoked. Invite = copy-a-link only (no email). Unguessable link (voiceId is not enough — add
a random token on the signoff record; the /s route requires both). Say plainly in the UI
that enforcement is client-side v1. Firestore rules for `speakers/**` documented in report
(speaker-owned write, owner-readable), NOT applied.

### VERIFIED — Verified Speech (`speech-synthesis-api.md` M2, steps 1–2; 3 only if clean)
E4 routes + `service/verify.py` (text normalizer shared by input & transcript comparison —
numerals/abbreviation tolerance; confidence floor: score only against high-confidence
words). SYNTH_CACHE carries alignment beside audio. `verify=strict` single-retry of the
offending segment ONLY if it lands cleanly within budget (bounded by existing admission) —
otherwise defer explicitly. Tests: stub stt (existing patterns) for shape/degrade paths +
a real-normalizer unit suite; pin the default route byte-identical when verify absent.

### SLO — SLO Capacity Contract (`loadtest-certification.md` M2, steps 1–4; 5 optional)
E5: workload.py (+tests: mean rate, determinism, varied corpus defeats cache by
construction); open-loop driver in loadtest.py (offered_rate, goodput_req_s, queue_wait_p95
from the /metrics queued delta, slo_violation_rate; reuse _one/_sample_resources; HARD
--max-in-flight breaker + "idle box" warning in --help); SLO predicate in level_degraded
(existing rules stay as fallback); --soak minutes; certify sustains_slo + capacity block +
CERT_VERSION gravitone-cert/3 (existing v2 tests keep passing for v2 verification paths —
extend, don't break). Saturation-curve fit + --probe (step 5) only if in budget; the web
planner (step 6) is deferred to a later batch. All pure cores unit-tested without a server
(the loadtest.py house style).

### APPLIANCE — Sealed Appliance (`packaging-deployment.md` M1 steps 1–2+4+6; M2 NOT here)
(1) Dockerfile installs from requirements.txt (kills the divergence that ships a product
that cannot listen); (2) bake stage: multi-stage build running each downloader
(faster-whisper, `python -m service.diarize --download`, piper voices for a small default
locale set, pocket-tts weights) into /opt/gravitone/models, runtime env pinned
(HF_HOME/XDG_CACHE_HOME/PIPER_VOICE_DIR, HF_HUB_OFFLINE=1 — a missing bake fails LOUDLY);
(4) E6 manifest module + GET /v1/appliance on own router; (6) `docker save` flow +
scripts/airgap-install.sh reusing bootstrap.sh's systemd unit. Author
`.github/workflows/sealed.yml` (--network none capability gate: clone → synth → stt →
scripted convai turn) but mark it authored-not-run. ⚠ THIS BOX CANNOT BUILD THE IMAGE
(aarch64-only base, Windows x86 host) — your gates are: appliance.py unit tests (fixture
model dirs), bash -n on scripts, Dockerfile reviewed against the stage contract, and an
explicit NOT-BUILD-TESTED banner in your report. Do not pretend otherwise.

## 5. Gates
Service builders: your modules + `test_private_surface`, `test_handler_modes`,
`test_loadtest` (SLO), `test_certify` (SLO), `test_compat` (VERIFIED — response-shape
guards) — all green; py_compile. Web builders: tsc clean + full vitest green except the
known PlaygroundConsole load flake. No next build (orchestrator). NO git. ASCII output.
stt/sherpa/torch absent on this box — stub per existing conventions.

## 6. Reports
Reply <150 words (status/files/tests/hooks). Include exact hook patches (PROVING: auth.py
if needed; APPLIANCE: none expected beyond router wiring). Orchestrator persists reports
under `batch3/`.
