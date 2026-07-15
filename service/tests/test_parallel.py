"""Direction 2 — parallel multi-segment synthesis + no parked threads.

Proves (mocked engine): multi-segment /v1/speak and /v1/performance occupy
>=2 workers concurrently, output order is unchanged, mid-script admission
rejection fails the whole request with 429, and _await_result bridges the
engine Future without a default-executor thread (wrap_future, not
run_in_executor(None, future.result)).
"""
from __future__ import annotations

import asyncio
import base64
import json
import threading
import types
import unittest
from concurrent.futures import Future

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
from service.engine import SynthResult

_EMAP = {"baseline": "v_base", "happy": "v_happy", "sad": "v_sad"}


class ParallelSpeakTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_emap = appmod.emotion_map
        appmod.emotion_map = lambda cid: dict(_EMAP)
        from fastapi.testclient import TestClient
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        eng = appmod.ENGINE
        if isinstance(eng, fake_engine.FakeEngine):
            eng.close()  # don't leak the fake's worker pool
        appmod.ENGINE = self._orig_engine
        appmod.emotion_map = self._orig_emap

    def test_speak_runs_segments_concurrently_in_order(self) -> None:
        eng = fake_engine.FakeEngine(workers=2, delay=0.2)
        appmod.ENGINE = eng
        resp = self.client.post(
            "/v1/speak",
            json={"character_id": "sarah",
                  "text": "[happy]Hello[/happy] [sad]World"},
        )
        self.assertEqual(resp.status_code, 200)
        # Both segments occupied a worker at the same time.
        self.assertGreaterEqual(eng.max_concurrent, 2)
        # Order preserved: submission order and the per-segment report.
        self.assertEqual(eng.submit_order, ["Hello", "World"])
        report = json.loads(base64.b64decode(resp.headers["x-segments"]))
        self.assertEqual([r["text"] for r in report], ["Hello", "World"])
        self.assertEqual([r["voice_id"] for r in report], ["v_happy", "v_sad"])

    def test_speak_midscript_rejection_fails_whole_request_429(self) -> None:
        # capacity 1: the 2nd segment's admission is refused -> whole 429.
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delay=0.02, capacity=1)
        resp = self.client.post(
            "/v1/speak",
            json={"character_id": "sarah",
                  "text": "[happy]Hello[/happy] [sad]World"},
        )
        self.assertEqual(resp.status_code, 429)
        self.assertEqual(resp.headers["retry-after"], "1")


class ParallelPerformanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_emap = appmod.emotion_map
        appmod.emotion_map = lambda cid: dict(_EMAP)
        from fastapi.testclient import TestClient
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        eng = appmod.ENGINE
        if isinstance(eng, fake_engine.FakeEngine):
            eng.close()  # don't leak the fake's worker pool
        appmod.ENGINE = self._orig_engine
        appmod.emotion_map = self._orig_emap

    def test_performance_lines_run_concurrently_in_order(self) -> None:
        eng = fake_engine.FakeEngine(workers=2, delay=0.2)
        appmod.ENGINE = eng
        resp = self.client.post(
            "/v1/performance",
            json={"lines": [
                {"character_id": "sarah", "text": "[happy]Line one"},
                {"character_id": "sarah", "text": "[sad]Line two"},
            ]},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertGreaterEqual(eng.max_concurrent, 2)
        self.assertEqual(eng.submit_order, ["Line one", "Line two"])
        report = json.loads(base64.b64decode(resp.headers["x-performance-report"]))
        self.assertEqual([r["line"] for r in report], [0, 1])
        self.assertEqual([r["text"] for r in report], ["Line one", "Line two"])


class AwaitResultTests(unittest.TestCase):
    def test_await_result_uses_wrap_future_not_executor(self) -> None:
        # If _await_result parked a thread via run_in_executor(None, ...),
        # this sabotaged executor would blow up. wrap_future never calls it.
        async def _drive():
            loop = asyncio.get_running_loop()

            def _boom(*a, **k):
                raise AssertionError("run_in_executor must not be used to wait")

            loop.run_in_executor = _boom  # type: ignore[method-assign]
            fut: Future = Future()
            threading.Timer(0.03, lambda: fut.set_result(SynthResult(
                wav_bytes=fake_engine.make_wav(1), sample_rate=24000,
                audio_seconds=1.0, synth_seconds=0.03, queue_seconds=0.0,
            ))).start()
            job = types.SimpleNamespace(future=fut)
            return await appmod._await_result(job)

        res = asyncio.run(_drive())
        self.assertEqual(res.sample_rate, 24000)


if __name__ == "__main__":
    unittest.main()
