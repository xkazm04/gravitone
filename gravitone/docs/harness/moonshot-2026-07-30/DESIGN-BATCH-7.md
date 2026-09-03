# Batch 7 Design — "The Deferred Frontier" (overnight continuation)

> Five features from the DEFERRED pool of ACCEPTED moonshots — each is a named later-step
> of a proposal the user already accepted at triage; no new scope is invented. Chosen for
> executability on this box (no Arm, no AWS, no live services).
>
> Branch: continue on `vibeman/moonshot-batch-1` (post-merge with main — Agent.counterpart
> now exists in dialog.py). Builders NEVER run git. All campaign vocabulary + learnings
> binding (docs/harness/harness-learnings.md 2026-07-30 sections — READ THEM: two-file
> header rule, single-owner matrix, named refusals, absent=invisible).

## 1. Features and their provenance
| Agent | Deferred item | From accepted proposal |
|---|---|---|
| **NARRATE** | /v1/narrate + bake script + narrate.js embed | app-shell-landing M2 steps 3–5 |
| **LOCKFILE** | gravitone.lock + build zip + `gravitone build` client | speech-synthesis-api M1 steps 4–5 |
| **LIMITER** | shared per-IP limiter + public re-perform + hero-demo hardening | sharing-packs M2 step 4 + followups-2026-07-10 hero-demo debt |
| **AUTOFILL** | demand-driven derive autofill + blind A/B harness + pack origin travel | voice-emotion-library M1 steps 5–6 + packs origin field |
| **LANES** | multi-lane score (ScriptLine stacking) + score on /t/ share pages | ui-design-system M2 steps 5–6 |

## 2. Contracts

### I1. NARRATE (service + web)
`service/narrate.py` (own APIRouter, orchestrator wires under `tts` scope):
`POST /v1/narrate {url? , markdown?, html?}` → readability extraction (stdlib html.parser —
no new deps; a `paste the text instead` fallback is the honest degrade), segmented
emotion-tagged narration PLAN {narration_id, blocks: [{text, emotion, character_hint}]} —
synthesis happens lazily per block via the existing TTS path (reuse admission; no
pre-render of whole pages). SSRF guards MANDATORY: allowlist-default-off for remote URLs
(setting `narrate_allow_hosts`, empty = local/markdown-only), no private/link-local targets,
no redirects to them, size/time caps — named refusals. Web: `scripts/bake-narration.ts`
(build-time: content-hash each narratable block → static audio artifacts; degrades to a
no-op with a named notice when the service is absent) + `public/narrate.js` embed (reads
data-voice + data-host, injects a minimal dock pointing at the HOST deployment; no secrets;
documented in README section). NarrationDock gains "powered by /v1/narrate" for arbitrary-id
playback. NO autoplay anywhere.

### I2. LOCKFILE (service + client)
`/v1/build` grows: `GET /v1/build/{build_id}.zip` (bounded, streamed, admission-aware) and
lockfile emission — `POST /v1/build/lock` → `gravitone.lock` JSON {line id → digest →
engine/voice/format versions} (documented schema, versioned). `scripts/gravitone-build.mjs`
client: reads a script file (documented format), calls /v1/build/plan, prints the diff,
`--check` exits non-zero on drift (CI primitive), `--lock` writes the lockfile, `--fetch`
pulls changed artifacts. Plus `.github/workflows/audio-drift.yml.example` (an EXAMPLE file,
not an active workflow — teams copy it). All node-stdlib, tests via node --test.

### I3. LIMITER (service + web)
`service/ratelimit.py`: shared fixed-window+burst per-IP limiter (stdlib, monotonic clock,
bounded memory, X-Forwarded-For honored ONLY behind a trust flag — default direct-peer),
named 429 with Retry-After. Applied to: hero-demo path (the /api/voices clone + /api/tts
demo flow — the service endpoints those proxies hit get a `demo` budget via a dependency),
and NEW public re-perform: `POST /v1/takes/{id}/reperform {text_edits}` — one edit, one
render, child take minted with lineage (reuses batch-5 parent_id/derived_from + direction
recording), ONLY when the parent take was published with `allow_reperform: true` (publish
opt-in, default OFF), hard per-IP budget, children excluded from lineage-breaking eviction
(already leaf-first). Web: /t/[id] gains the re-perform panel (one text field pre-filled,
emotion chips, render → child link; provenance banner; named refusals incl. rate limit),
publish flow gains the opt-in toggle.

### I4. AUTOFILL (service)
Algebra continuation, ALL still gated on the basis (synthetic-tensor tests only here):
`service/tools/derive_autofill.py` — reads `demand.all_demand()`, derives the hottest
missing slot per character (cap per run, reversible via the normal delete path), refuses
named when no basis/no-go; `service/tools/derive_ab.py` — blind A/B harness: for speakers
who DO have a real slot, synthesize real vs derived renders of a fixed line (engine
required → degrades named here), score with prosody probe distance, write per-emotion
transfer quality into `_basis.json`; derivation REFUSES emotions whose measured transfer
quality is below threshold (wire the check into the derive endpoint). packs.py: registry
rows travel `origin`/`derived_from`/`prosody`/`fidelity` wholesale on export AND import
(the batch-1 deferred "verify rows are copied wholesale" — verify + test + fix if wrong);
imported derived slots stay `derived`.

### I5. LANES (web)
`ScoreEditor` gains a script mode: one Track lane per ScriptLine, tinted by character hue,
sequenced vertically; per-lane regions edit that line's tags (same toTags/parseTags);
lane click focuses the composer line. Share surfaces: /t/[id] renders the take's segment
score (read-only Track + regions from the take's segments/X-Performance-Report data — the
same visual language as the editor) under the player. Keyboard + reduced-motion complete.
Mount diffs ≤10 lines each for PlaygroundConsole (script-mode score block) and the /t page
if not owned — LANES owns /t/[id] read-surface additions this batch (REMIX's work landed;
coordinate via git-less additive files).

## 3. File ownership (HARD)

| Agent | Owns | Must NOT touch |
|---|---|---|
| **NARRATE** | `service/narrate.py` + tests, `web/scripts/bake-narration.ts`, `web/public/narrate.js`, NarrationDock.tsx + narrationCache.ts (extend), README narrate section | `service/app.py` (router line in reply), everything else |
| **LOCKFILE** | `service/app.py` (build routes only), `service/buildstore.py`, `scripts/gravitone-build.mjs`, `.github/workflows/audio-drift.yml.example`, their tests | `service/narrate.py`, `service/takes.py`, web/** |
| **LIMITER** | `service/ratelimit.py` (new), `service/takes.py` (reperform), their tests, `web/app/t/[id]/**` (re-perform panel ONLY — coordinate with LANES via separate files), publish-flow toggle in `web/app/playground/_variants/` takes-log publish site | `service/app.py` (dependency wiring in reply), engine.py, LANES' score files |
| **AUTOFILL** | `service/tools/derive_autofill.py`, `service/tools/derive_ab.py`, `service/emotion_basis.py`, `service/voices.py` (threshold check in derive), `service/packs.py`, their tests | emotions.py, ingest*, app.py, web/** |
| **LANES** | ScoreEditor/Track/Region files + shared.ts (additive), `web/app/t/[id]/TakeScore.tsx` (new file only), colocated tests | PlaygroundConsole (mount diff in reply), LIMITER's /t files (RePerform*), service/** |

/t/[id] is SHARED between LIMITER and LANES this batch — each adds its OWN new component
file; page.tsx integration diffs go in replies if both need it (orchestrator composes).
app.py: LOCKFILE owns it; NARRATE router + LIMITER dependency wiring ship as reply patches.

## 4. Gates
Service: your modules + test_private_surface + test_takes_reviews (LIMITER) +
test_buildstore + test_compat + test_verify (LOCKFILE) + test_registry_invariants +
test_pack_safety (AUTOFILL) — green; py_compile; full per-module loop is the orchestrator's.
Web: tsc + full vitest green except the tracked PlaygroundConsole flake. node --test for
client scripts. NO git. ASCII. SSRF guards tested (NARRATE), limiter clock tests monotonic.

## 5. Reports
Reply <200 words: status/files/tests/hooks (+ exact app.py patches from NARRATE/LIMITER,
mount diffs from LANES). Orchestrator persists under `batch7/`.
