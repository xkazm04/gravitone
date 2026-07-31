# REPORT — HANDSHAKE (Key-as-Handshake), Batch 4

> Saved by the orchestrator from the builder's inline report.

**Status: complete.** All F3 items shipped.

Files (new unless noted):
- `web/app/keys/_variants/`: capabilities.ts (THE typed table + SCOPES + foldProof),
  serviceRoutes.ts (checked route snapshot), agentConfig.ts (MCP/OpenAI block builders),
  AgentBlocks.tsx, capabilities.test.ts; edited data.ts (re-exports SCOPES),
  MigrationKit.tsx (4th "agents" tab + keyId prop), SecretReveal.tsx, KeysLedger.tsx
  (per-row "agent config" expander).
- `web/app/api/keys/`: deployment.ts, [id]/manifest/route.ts + test, wellKnown.test.ts.
- `web/app/.well-known/gravitone.json/route.ts`.
- `agents/mcp-gravitone/`: server.mjs, lib/{config,manifest,call,rpc}.mjs, test/*, README,
  own package.json — ZERO deps (hand-rolled JSON-RPC stdio).

Tests: node --test 32/32; vitest 73/73 own files; tsc clean. Full-suite reds at report time:
lib/narratable.test.ts (AUDIBLE in flight) + lib/serviceHeaders.test.ts (BUILD's new
ETag/X-Speech-Digest → orchestrator mirrors at integration). Neither this builder's.

Hooks: none. Secrets default to ${GRAVITONE_API_KEY} env refs; raw value opt-in with stated
reason. Manifest folds PROVING attestations as proven: true|false|unknown.
