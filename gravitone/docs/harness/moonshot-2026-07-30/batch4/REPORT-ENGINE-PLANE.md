# REPORT — ENGINE-PLANE (Speech Engine Plane), Batch 4

> Saved by the orchestrator from the builder's inline report.

**Status: complete.**

Files: `service/engines.py` (new: frozen EngineCapabilities, POCKET_LANGUAGES,
VoiceUnavailable, Resolution, SpeechEngine protocol, live PiperEngine/PocketEngine adapters,
boot declaration-conformance + record_conformance seam, GET /v1/engines on own router);
`service/convai.py` (shim ONLY: _POCKET_LANGUAGES/VoiceUnavailable re-exported as the SAME
objects, _resolve_voice delegates to engines.resolve); `service/tests/engine_conformance.py`;
`service/tests/test_engines.py`.

Tests: 169 green across test_engines(26) + engine_conformance(24) + piper + polyglot +
convai_protocol + zero_gap + private_surface (piper/polyglot UNMODIFIED — the router's spec
held); plus handler_modes/compat/verify/dialog/gym 191 green. py_compile clean.

Router include (relayed to BUILD, the app.py owner, mid-flight):
`from service.engines import router as engines_router`
`app.include_router(engines_router, dependencies=[Depends(require_scope("tts"))])`
plus `engines.set_pool_provider(lambda: ENGINE)` at startup (falls back to convai's provider).

Deferred (per design): full request-path routing through the SpeechEngine protocol; third
engine (kokoro/espeak floor); ENGINES= allow/deny policy; out-of-tree entry-point adapters.
