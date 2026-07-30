# REPORT — ZERO-GAP (Zero-gap turn-taking), Batch 2

> Saved by the orchestrator from the builder's inline report.

**Status: complete.** All four M2 steps behind D6 flags, default OFF.

Files: `service/convai.py`, `stt.py`, `vad.py`, `cache.py`, `config.py` (new settings only);
tests `test_zero_gap.py` (new, 38), `test_vad.py` (+13), `test_stt.py` (+11), `test_cache.py` (+4).

Flags: `convai_partial_decode` (+`_interval_ms`/`_min_ms`), `convai_speculate`
(+`_min_chars`), `convai_openers` (+`_opener_agents`/`_opener_phrases`/`_opener_cache_bytes`),
`convai_echo_suppression` (+`_attenuation_db`/`_lag_ms`).

Tests: required 8 modules + new = 201 green; full suite 1050 OK (5 skipped); py_compile
clean. Speculation timing re-run 3×, stable.

Invariants pinned: partial never in history/transcript; no `audio` before `agent_response` on
cancelled/wrong speculation; opener silent on a wordless utterance; flags-off turn asserted
byte-identical (final user_transcript event exactly `{user_transcript}`, no interim, brain
asked once).

Hooks: none. Note for POLYGLOT: speculated replies flow through the unchanged `_speak`, so
the per-part patch applies as-is. Latency published via `Recorder.note(latency=...)` +
`GET /v1/convai/agents.speculation`.
