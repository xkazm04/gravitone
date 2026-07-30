# Moonshot scan — API Key Management (web) — 2026-07-30

Context files read: `web/app/keys/page.tsx`, `web/app/keys/_variants/{KeysLedger,SecretReveal,MigrationKit,data}.tsx|ts`,
`web/app/api/keys/route.ts`, `web/app/api/keys/[id]/route.ts`, `web/app/api/keys/[id]/revoke/route.ts`, `web/lib/backend.ts`,
`docs/harness/followups-2026-07-10.md`.

Scaffold reality this builds on: the ledger already knows it is *guessing* about posture
(`data.ts::Enforcement` = enforced | unknown | unreachable, "unknown" because every request goes
through `lib/backend.ts::backendFetch`, which silently attaches the studio's root `GRAVITONE_API_KEY`).
Scope chips are **declared strings** — nothing in the studio has ever observed a key being accepted
or refused at an endpoint. Both moonshots below turn that unverified surface into a verified one, in
two different directions: one proves the deployment to its operator, one exports the key as a
machine-consumable capability so agents can self-integrate.

Neither overlaps the rejected clusters (no metering, no tiers/sub-keys, no pricing, no white-label,
no cast cloning) nor the shipped switch-kit / migration-kit / capacity-certificate work; the
follow-ups doc's deferred items (streaming, shadow mode, packs gallery, ownership enforcement,
Ed25519 pack signing) are untouched.

---

## M1. The Proving Ledger — every key ships with an empirically proven least-privilege matrix

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: Turns API keys from *claims* into *evidence*: at mint/rotate time the studio replays a
  matrix of real probes with the new secret (and with no secret at all) and stores the observed
  verdicts, so the ledger shows what each key can actually reach on this deployment — and can finally
  state posture as fact instead of "can't tell from here".
- **Feasibility**: high
- **Time-horizon**: weeks
- **Why it's a moonshot**: No TTS/voice vendor — ElevenLabs included — shows you a *proven* privilege
  matrix per key; they all show you the scopes you typed. The one moment when the studio holds a raw
  secret (`SecretReveal`, where `MigrationKit` already replays one live request) is exactly the moment
  a full conformance sweep is possible, and it's currently spent on a single happy-path tick. It also
  dissolves the honest-but-useless `unknown` enforcement state, because an unauthenticated probe from
  a *server route* (not the browser) is the one measurement that separates a keyed backend from an
  open one, and no root key needs to be attached to make it.
- **Path to implementation**:
  1. Add `web/app/api/keys/probe/route.ts`: a server route that calls the backend via a **bare**
     fetch (bypassing `backendFetch`'s root-key injection — export a `backendFetchRaw`/`{ bare: true }`
     option in `lib/backend.ts`) and reports the raw status. First probe: unauthenticated `GET /v1/voices`.
     A 401 proves enforcement; a 200 proves the deployment serves *everyone* — which today's UI can
     only warn might be true. Replace `Enforcement` with `enforced | open | unreachable`, and make
     `EnforcementNote`'s `open` case the loudest thing on the page.
  2. Extend the probe route to accept a secret + a scope list and run one cheap read per scope
     (`/v1/voices` for `voices`, a 1-word `/v1/text-to-speech` for `tts`, an intentionally malformed
     `/v1/performance` for `performance`, etc.) plus **negative** probes for scopes the key did *not*
     request — a 403 there is the proof that scoping works. Return `{scope, expected, observed, verdict}[]`.
  3. In `SecretReveal`, promote `MigrationKit`'s single check into a "prove this key" sweep rendering
     the matrix (✓ granted-and-reachable / ✓ correctly-refused / ✗ granted-but-refused /
     ⚠ refused-scope-served-anyway). Keep the existing snippet panel; the sweep sits above it.
  4. Persist the verdict summary alongside the key (backend `PATCH /v1/keys/{id}` attestation field,
     or a studio-side store if the service model can't grow) so `KeysLedger` scope chips render
     *proven* (solid) vs *declared-only* (outlined) — the same visual honesty grammar the page
     already uses for revoked rows.
  5. Add a "re-prove" row action that re-runs only the secretless probes (posture + 401/403 shape) for
     existing keys, so a key minted before this feature still gets a posture verdict without its secret.
  6. Ship a headless twin: `scripts/prove-keys.mjs` (or a service CLI) emitting the same matrix as JSON
     with a non-zero exit on any ⚠ row, so the proof runs in CI/deploy pipelines, not just in a browser tab.
- **Dependencies**: a bare (root-key-free) server fetch path in `lib/backend.ts`; per-scope probe
  requests that are cheap and side-effect-free (a 1-word synth is ~fine; clone/stt need read-only or
  deliberately-invalid variants that fail *at auth*, before work starts); optional service-side field
  to store the attestation; `service/auth.py` must actually return 403-vs-401 distinctly for
  wrong-scope vs no-key (verify; if it 401s both, step 2's negative probes need the service to
  differentiate first).
- **Risks**: probe traffic touches a CPU-bound synth box — must be capped, serialized, and never run
  automatically on page load (mint/rotate + explicit button only). Negative probes that *succeed*
  reveal a real vulnerability to whoever is looking, so the wording must be an alert, not a shrug. A
  stored attestation goes stale the moment `TTS_API_KEY` changes on the box, so every proven chip must
  carry the timestamp of the probe that proved it.
- **What changes if we ship it**: Gravitone becomes the only voice API whose key page can *prove*
  least privilege on your own deployment, and the most dangerous silent misconfiguration in the
  product (an unkeyed service serving the world) becomes impossible to miss.

---

## M2. Key-as-Handshake — one paste turns a key into a self-configuring agent integration

- **Tier**: 2 (3-5x)
- **Category**: platform
- **Impact**: Every issued key gains a machine-readable capability manifest and a generated
  agent-native install line, so an LLM agent (Claude/MCP client, LangChain-style tool loader, or any
  autonomous runtime) can be handed the key and self-configure Gravitone's voice tools — scoped
  exactly to that key — without a human reading docs.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: The current key flow optimizes for a *human* migrating a codebase
  (curl/Python/JS snippets). The fastest-growing consumer of speech APIs is not a human at all — it's
  an agent that needs to discover, not read. Making the key itself the entire integration contract
  (capabilities, limits, endpoint shape, scope boundaries) means distribution becomes viral through
  agent configs rather than through docs pages, and each installed agent is a deployment that already
  speaks Gravitone. It also compounds with M1: the manifest can advertise only *proven* capabilities.
- **Path to implementation**:
  1. Add `web/app/api/keys/[id]/manifest/route.ts`: derive a JSON capability manifest from the key's
     scopes using the existing `SCOPES` table in `_variants/data.ts` as the single source of truth
     (id, label, hint → endpoint, method, request/response schema, notes). Pure derivation, zero
     backend change, testable today.
  2. Publish the deployment-level half at `/.well-known/gravitone.json` (a Next route): base URL,
     auth header (`xi-api-key`), engine/format capabilities, and the CORS reality
     `MigrationKit` already explains — so a client that has only a key and a host can bootstrap.
  3. Add an "agents" tab to `MigrationKit`'s existing language switcher emitting (a) an MCP server
     config block with the freshly minted key inlined and (b) a generic OpenAI-style tool-schema JSON
     for non-MCP runtimes — same copy-once, same `useCopyFeedback` affordances.
  4. Ship the bridge in-repo: a small stdio MCP server (`agents/mcp-gravitone/`) that reads
     `GRAVITONE_API_KEY` + host, fetches the manifest, and exposes exactly the manifest's tools
     (`speak`, `perform`, `list_voices`, `transcribe`…). Tools absent from the manifest are absent
     from the agent's toolbox — the key's scopes become the agent's real boundary.
  5. Surface it in `KeysLedger`: a per-row "agent config" action regenerating the install block from
     the manifest (no secret needed — placeholder + a pointer to rotate if the secret was lost), plus
     a `last_used` read that finally has agent traffic to show.
  6. Fold in M1's verdicts once available: the manifest advertises `proven: true|false` per capability,
     so an agent never plans around a tool this deployment would refuse.
- **Dependencies**: `SCOPES` becoming a shared, typed capability table importable by server routes and
  the bridge (today it's a client-module constant); a stable request/response schema per endpoint
  (largely settled by the ElevenLabs-compat surface); the bridge is a new small package with its own
  test/CI path; scope→endpoint mapping must be kept honest against `service/auth.py`.
- **Risks**: a manifest that drifts from the service is worse than no manifest — needs a drift test
  that asserts every manifest endpoint exists and every enforced scope is represented. Embedding a
  secret in a copyable agent-config block puts credentials into config files agents may commit;
  default to an env-var reference with the raw value opt-in and say why. MCP surface area is a
  maintenance commitment beyond a single wave.
- **What changes if we ship it**: A Gravitone key stops being a string you paste into code and becomes
  a self-describing contract — agents integrate themselves, and every agent install carries the
  ElevenLabs-compatible base-URL swap with it.
