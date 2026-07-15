"""Direction 1 — streaming synthesis endpoint.

Verified with a mocked engine (no real model): time-to-first-byte, format
handling (pcm / wav / mp3-501), and that streaming does not disturb the
byte-for-byte behaviour of the non-stream route.
"""
from __future__ import annotations

import asyncio
import time
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
from service.app import TTSRequest
from fastapi.testclient import TestClient


class StreamingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = appmod.ENGINE
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        appmod.ENGINE = self._orig

    def test_first_chunk_before_last_segment_finishes(self) -> None:
        # seg0 is fast, the rest are slow -> the first chunk must leave the
        # generator long before the whole clip is synthesized. Measured on the
        # StreamingResponse body iterator directly: Starlette's TestClient
        # buffers the ASGI stream, so it cannot observe time-to-first-byte.
        delays = {"One.": 0.05, "Two.": 0.4, "Three.": 0.4}
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delays=delays)

        async def _drive():
            resp = await appmod.text_to_speech_stream(
                "test-voice", TTSRequest(text="One. Two. Three."),
                output_format="pcm_24000", emotion=None)
            self.assertEqual(resp.headers["x-stream-segments"], "3")
            start = time.perf_counter()
            ttfb = None
            count = 0
            async for chunk in resp.body_iterator:
                if chunk and ttfb is None:
                    ttfb = time.perf_counter() - start
                count += bool(chunk)
            return ttfb, time.perf_counter() - start, count

        ttfb, total, count = asyncio.run(_drive())
        self.assertEqual(count, 3)
        self.assertIsNotNone(ttfb)
        # ORDERING, not absolute wall-clock. The contract is "the first chunk is
        # yielded long before the whole clip is synthesized" — that's what a
        # RELATIVE bound expresses. The old `ttfb < 0.30` measured real thread
        # scheduling: on a CPU-throttled container, under GC/GIL contention, or
        # with Windows wake-up jitter, the 0.05s first chunk is observed past
        # 0.30s and the test goes red with no code change. A proportional bound
        # stretches with the machine (a uniform slowdown scales ttfb AND total),
        # so it stays honest without flaking.
        self.assertLess(
            ttfb, total * 0.5,
            f"first chunk should arrive early in the stream "
            f"(ttfb={ttfb:.3f}s of total={total:.3f}s)")

    def test_pcm_has_no_wav_header(self) -> None:
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delay=0.02)
        with self.client.stream(
            "POST", "/v1/text-to-speech/v/stream",
            params={"output_format": "pcm_24000"},
            json={"text": "Hello world. Second sentence."},
        ) as resp:
            body = resp.read()
        self.assertNotEqual(body[:4], b"RIFF")
        # two segments, 480 raw PCM bytes each (240 frames * 2 bytes)
        self.assertEqual(len(body), 2 * 480)

    def test_wav_is_single_header_then_samples(self) -> None:
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delay=0.02)
        with self.client.stream(
            "POST", "/v1/text-to-speech/v/stream",
            params={"output_format": "wav_24000"},
            json={"text": "Alpha. Beta. Gamma."},
        ) as resp:
            self.assertEqual(resp.headers["content-type"], "audio/wav")
            body = resp.read()
        self.assertEqual(body[:4], b"RIFF")
        self.assertEqual(body[8:12], b"WAVE")
        # exactly one header (44 bytes) + 3 * 480 sample bytes
        self.assertEqual(len(body), 44 + 3 * 480)

    def test_mp3_stream_returns_501(self) -> None:
        appmod.ENGINE = fake_engine.FakeEngine()
        resp = self.client.post(
            "/v1/text-to-speech/v/stream",
            params={"output_format": "mp3_24000_128"},
            json={"text": "Anything."},
        )
        self.assertEqual(resp.status_code, 501)
        self.assertIn("mp3", resp.json()["detail"].lower())

    def test_backpressure_returns_429_before_streaming(self) -> None:
        # capacity 1 but two sentences -> the second submit is rejected up front.
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delay=0.02, capacity=1)
        resp = self.client.post(
            "/v1/text-to-speech/v/stream",
            params={"output_format": "pcm_24000"},
            json={"text": "First one. Second one."},
        )
        self.assertEqual(resp.status_code, 429)
        self.assertEqual(resp.headers["retry-after"], "1")


if __name__ == "__main__":
    unittest.main()
