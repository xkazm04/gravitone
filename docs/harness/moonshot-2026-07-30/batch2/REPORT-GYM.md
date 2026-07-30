# REPORT — GYM (Conversation Gym), Batch 2

> Saved by the orchestrator from the builder's inline report.

**Status: done.** D3, proposal M1 steps 1–3.

Files: `service/gym.py` (new, ~900 lines), `service/tests/test_gym.py` (new, 55 tests),
`service/tests/fixtures/gym/basic/suite.json`.

app.py wiring (orchestrator applies, next to the convai includes):
```python
from service.gym import router as gym_router
app.include_router(gym_router, dependencies=[Depends(require_scope("convai"))])
```

Shipped: `replay()` — wire-paced base64 user_audio_chunk frames via
TestClient.websocket_connect, D3 artifact, recorder-sourced timings with wire fallback;
`compare()` — 7 named checks, WER labelled drift-vs-ASR-reference, answer_s/transcribe_s
distribution deltas, interruption/turn/agent-text diffs, exit_code 0/2 like certify;
suites + suite.json; CLI `python -m service.gym run|compare|suite`; POST /v1/convai/replay on
gym's own router (sync def, 409 when busy, 503 when convai disabled).

Design finding: an unpaced replay barges into its own agent — `polite=True` holds the feed
until the reply has arrived AND played out (the gate sees identical samples); compare()
refuses to score latency across different pacings.

Evidence: test_gym 55/55; convai_protocol+recording+private_surface+dialog+piper+stt 193 OK;
full service/tests discover 1019 OK (5 skipped); py_compile clean; CLI ASCII-asserted.

Hooks: none. NOTE: gym's interruption assertions ride convai's barge-in semantics —
re-run test_gym after ZERO-GAP lands.

Deferred: synthesized adversarial callers (step 4), coverage report (step 6).
