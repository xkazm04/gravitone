# REPORT — NARRATE (/v1/narrate + bake + embed), Batch 7

> Saved by the orchestrator from the builder's inline report. Router include + the
> /api/narrate/[id] proxy route applied by the orchestrator.

**Status: complete.**

Service — `service/narrate.py` (new, ASCII, no engine import): POST /v1/narrate
{url?|markdown?|html?} → bounded disk-backed plan store (takes.py discipline, narrations/),
GET /v1/narrate/{id}. Readability-lite via stdlib html.parser + line-based markdown; empty
extraction → 422 naming "paste the text instead". Blocks carry text/emotion/character_hint/
tagged_text/hash/addressing — addressing points ONLY at the ordinary TTS routes; no new
synthesis path. content_hash is an exact port of narratable.ts::contentHash (UTF-16 units),
golden-pinned on BOTH sides. SSRF: NARRATE_ALLOW_HOSTS (empty default = bodies only),
suffix rules that don't cover the apex, every resolved IP checked for global routability,
per-hop redirect re-validation (cap 3), declared+actual size caps, timeout, content-type —
each refusal a named sentence.

Web — scripts/bake-narration.ts + `bake:narration` (bare-Node via registerHooks bridge;
incremental, prunes stale clips, public/narration/<clipKey>.wav + manifest, named no-op when
service unreachable, --strict, --character=); public/narrate.js (14KB IIFE, shadow root,
listener's own key in sessionStorage, no autoplay, host-only traffic); NarrationDock
prefers cache → baked → live (source stated in the status line) + plays arbitrary plans via
?narration=<id>; narratable.ts gained routeFromPlan/manifest parsing. README section added.

Tests — test_narrate 36 green; private_surface + takes_reviews green; py_compile OK; tsc
clean; full vitest 915/915 (PlaygroundConsole passed). Bake tests under lib/ because
vitest.config only collects {app,lib,components}.

Hooks: none (both patches applied).
