# Batch 4 Design — "The Platform Plane"

> Five features, one story: **Gravitone stops being one model with an API and becomes the
> place speech plugs in.** Engines become declared, conformance-tested adapters (Speech
> Engine Plane); audio becomes a content-addressed build artifact (Speech as Build
> Artifact); a key becomes a self-configuring agent integration (Key-as-Handshake); the
> site narrates itself and the narrator becomes a product seed (Audible Docs); and the
> artifact writes its own deployment topology from measured certificates (Deployment
> Compiler).
>
> Branch: `vibeman/moonshot-batch-1` (continues). Builders NEVER run git. All batch-1/2/3
> vocabulary binding (named facts, proven-vs-declared, absent=invisible, TakePlayer/AudioBus,
> tokens only, honest refusals, opt-in never autoplay).

## 1. Shared contracts

### F1. Engine plane (service, owned by ENGINE-PLANE)
`service/engines.py`: frozen `EngineCapabilities(engine_id, languages, clones, emotions,
native_rate, license, install_hint)`; registry of exactly the two real engines (pocket-tts
from `convai._POCKET_LANGUAGES` + voice registry; piper from `piper.list_voices()`/`info()`);
`resolve(language, voice_id) -> (engine_id, voice_id)` implementing convai's existing 4 rules
with the SAME authored VoiceUnavailable text; `GET /v1/engines` on engines' OWN router
(orchestrator wires). convai.py keeps `_resolve_voice` as a thin re-export so
`test_piper.VoiceResolutionTests` and POLYGLOT's `_mouth` pass UNMODIFIED — that suite is the
router's spec. `service/tests/engine_conformance.py`: parameterized suite every adapter must
pass (honest sample rate, empty text = silence not error, unknown-voice message names the
install path, single-synthesis lock under concurrency, WAV correctness, capability claims
match observed behaviour). Full request-path routing through a SpeechEngine protocol is
NOT this batch — adapters are real and conformance-tested, dispatch stays where it is.

### F2. Build artifact (service, owned by BUILD)
- `X-Speech-Digest: sha256:<hex>` on POST /v1/text-to-speech — over voice fingerprint +
  normalized text + overrides + frames_after_eos + engine/model version + output format +
  segmentation version. `If-None-Match` → 304. DIGEST LAW: any change to normalization,
  chunking, resampling or weights MUST bump a version component — pin with a golden
  digest-stability test (fixture manifest → exact digests).
- `service/buildstore.py`: durable content-addressed store (atomicio discipline),
  `GET/HEAD /v1/audio/{digest}`, capped + LRU-pruned with a named setting.
- `POST /v1/build` {lines: [{id, voice, text, emotion?, settings?, format?}]} → per-line
  {id, digest, state: fresh|rendered} with NO audio bytes; manifest size capped; reuses
  the existing admission/backpressure. `POST /v1/build/plan` = dry-run diff ("what would
  change"). Lockfile emission (`gravitone.lock`) + zip delivery deferred if tight.

### F3. Key manifest (web + bridge, owned by HANDSHAKE)
`GET /api/keys/[id]/manifest` derived from a SINGLE typed capability table (promote
`SCOPES` in `data.ts` to a shared module importable by server routes); deployment half at
`/.well-known/gravitone.json` (base URL, auth header, formats, CORS reality). MigrationKit
gains an "agents" tab: MCP server config block + OpenAI-style tool schema — secrets as
env-var references BY DEFAULT (raw value opt-in with a stated reason). In-repo bridge
`agents/mcp-gravitone/` (stdio MCP server: reads key+host, fetches manifest, exposes exactly
the manifest's tools). Drift test: every endpoint the manifest names must exist in the
capability table AND be asserted against the service's known route list (checked snapshot —
update deliberately, never silently).

### F4. Narration (web, owned by AUDIBLE)
`web/lib/narratable.ts` route→blocks registry (landing sections from `lib/content.ts`,
/benchmarks copy from `lib/benchmarks.ts`); `components/ui/NarrationDock.tsx` mounted in
layout.tsx — STRICTLY opt-in (no autoplay ever; `?narrate=1` arms the dock, still requires
one click), sequential sentences through /api/speak, Character-per-section-role +
[emotion] metatags, scroll-follow highlight, narrator choice persisted, keyboard operable,
reduced-motion respected, playback registered with AudioBus (the frame reacts). Content-hash
cache in IndexedDB (per existing playgroundDb patterns) so repeat listens are free;
build-time baking + /v1/narrate + embeds are LATER batches.

### F5. Deployment plan (service+deploy, owned by COMPILER)
`python -m service.plan`: read a certification (v2 or v3) → `deployment-plan.json`
{replicas, torch_threads, queue_max, resources{cpu,memory}, autoscaling{mode,target},
roles: {synth, converse, ingest: {affine: true}}} with floors/ceilings; REFUSES a failing
or predicted-only cert (exit 2, named reason); `--emit helm-values` and `--emit compose`
render deploy artifacts from the same plan; `deploy/bootstrap.sh` consumes a plan when
present (`PLAN=` override, defaults preserved without one) and uses
`python -m service.replicas --replicas N` on multi-replica plans. Pure stdlib, fixture-cert
tests. Role-scoped images already exist via the Dockerfile build args (batch 3) — reference,
don't rebuild.

## 2. File ownership (HARD)

| Agent | Owns | Must NOT touch |
|---|---|---|
| **ENGINE-PLANE** | `service/engines.py` (new), `service/convai.py` (re-export shim ONLY), `service/tests/engine_conformance.py` + `test_engines.py` | `service/app.py`, `service/piper.py`, `service/dialog.py`, web/** |
| **BUILD** | `service/app.py`, `service/buildstore.py` (new), their tests | `service/convai.py`, `service/engines.py`, `service/cache.py`, web/** |
| **HANDSHAKE** | `web/app/keys/**`, `web/app/api/keys/**`, `web/app/.well-known/**` (new), `agents/mcp-gravitone/**` (new) | `web/lib/backend.ts`, `web/app/profile/**`, service/** |
| **AUDIBLE** | `web/lib/narratable.ts` (new), `web/components/ui/NarrationDock.tsx` (new), `web/app/layout.tsx` (mount only) | `web/lib/content.ts` + `web/lib/benchmarks.ts` (read-only), `web/app/keys/**`, `web/components/ui/*` existing files except additive imports, service/** |
| **COMPILER** | `service/plan.py` (new), `service/tests/test_plan.py`, `deploy/**` | `service/certify.py`, `service/replicas.py` (read-only), Dockerfile, web/** |

app.py single owner: BUILD. convai.py single owner: ENGINE-PLANE (shim only — behaviour
pinned by existing suites). deploy/ single owner: COMPILER.

## 3. Gates
Service: your modules + `test_private_surface`, `test_handler_modes`, `test_compat`,
`test_piper`, `test_polyglot_turn`, `test_convai_protocol`, `test_verify` (BUILD
especially — app.py is shared history) — green; py_compile. Web: tsc clean + full vitest
green except the tracked PlaygroundConsole load flake. Bridge (`agents/mcp-gravitone`):
self-contained node package with its own tests runnable via `node --test` (no new root
deps). NO git. ASCII output. No live services assumed.

## 4. Reports
Reply <150 words: status/files/tests/hooks (+ router include line from ENGINE-PLANE).
Orchestrator persists under `batch4/`.
