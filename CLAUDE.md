# Gravitone - working agreement for agents

Gravitone is a CPU-only, Arm-native text-to-speech and speech-to-text service with voice cloning,
shaped like a hosted TTS API and shipped as a sealed appliance image plus a Helm chart. The README
is the pitch; the documents below are the contract.

- `.ai/manifest.yaml` - what this repo is, which commands fulfil which capability, what an agent
  must never touch, and the `scope:` block the registry's direction pass reads. Its spec is
  `.ai/SPEC.md` and resolves offline.
- `context-map.json` - the owner's generated map (15 groups, 78 contexts) the registry map is built from (speech synthesis, capacity and admission,
  listening, conversation, voices and characters, certification and deployment, integrations,
  quality harness). Read it at task start and scope edits to one context's files.
- `gravitone/deploy/README.md` - measure, plan, deploy: the chart's defaults are one box's numbers, and
  `python -m service.plan` writes the overlay for other silicon.
- `gravitone/docs/harness/harness-learnings.md` - how the suite really runs: `cd gravitone && python -m unittest
  service.tests.<module>`, one module per run, no pytest, weights not needed under test.
- `.claude/rules/` - links to the registry's access rule and the software-engineering rule.

Rules of the road: model weights, voices and recordings are assets and are never edited; the
remote is public, so no key ever lands in a commit; the ship gate is the full per-module test loop
and a wave is never green on a subset.
