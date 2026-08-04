"""Direction 1 — streaming synthesis endpoint.

Verified with a mocked engine (no real model): time-to-first-byte, format
handling (pcm / wav / mp3-501), and that streaming does not disturb the
byte-for-byte behaviour of the non-stream route.
"""
from __future__ import annotations

import asyncio
import dataclasses
import time
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
from service.app import TTSRequest
from fastapi.testclient import TestClient


class StreamingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = appmod.ENGINE
        self._orig_settings = appmod.SETTINGS
        # These cases exercise per-SEGMENT mechanics, so pin one segment per
        # sentence: with the production chunk budget (350 chars) their short
        # fixtures would coalesce into a single unit and prove nothing.
        appmod.SETTINGS = dataclasses.replace(appmod.SETTINGS, chunk_chars=1)
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        appmod.ENGINE = self._orig
        appmod.SETTINGS = self._orig_settings

    def test_first_chunk_before_last_segment_finishes(self) -> None:
        # seg0 is fast, the rest are slow -> the first chunk must leave the
        # generator long before the whole clip is synthesized. Measured on the
        # StreamingResponse body iterator directly: Starlette's TestClient
        # buffers the ASGI stream, so it cannot observe time-to-first-byte.
        delays = {"One.": 0.05, "Two.": 0.4, "Three.": 0.4}
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delays=delays)

        async def _drive():
            resp = await appmod.text_to_speech_stream(
                "alba", TTSRequest(text="One. Two. Three."),
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
            "POST", "/v1/text-to-speech/alba/stream",
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
            "POST", "/v1/text-to-speech/alba/stream",
            params={"output_format": "wav_24000"},
            json={"text": "Alpha. Beta. Gamma."},
        ) as resp:
            self.assertEqual(resp.headers["content-type"], "audio/wav")
            body = resp.read()
        self.assertEqual(body[:4], b"RIFF")
        self.assertEqual(body[8:12], b"WAVE")
        # exactly one header (44 bytes) + 3 * 480 sample bytes
        self.assertEqual(len(body), 44 + 3 * 480)

    def test_mp3_stream_falls_back_to_a_labelled_full_body(self) -> None:
        """mp3 on /stream serves the whole clip and SAYS it is not a stream.

        It used to 501. That refusal was correct about mp3 (there is no
        incremental transcode) and wrong about the product: mp3_44100_128 is
        the ElevenLabs SDK's DEFAULT for this endpoint, so every unmodified
        `client.text_to_speech.stream(...)` failed on a base-URL swap. Now it
        succeeds as one full body, and the honesty moves into a header instead
        of a status code.
        """
        import service.engine as enginemod
        import types as _t

        appmod.ENGINE = fake_engine.FakeEngine()

        def fake_run(cmd, input=None, stdout=None, stderr=None, **kw):
            return _t.SimpleNamespace(returncode=0, stdout=b"MP3DATA", stderr=b"")

        orig = enginemod.subprocess.run
        enginemod.subprocess.run = fake_run
        try:
            resp = self.client.post(
                "/v1/text-to-speech/alba/stream",
                params={"output_format": "mp3_24000_128"},
                json={"text": "Anything."},
            )
        finally:
            enginemod.subprocess.run = orig

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers["content-type"], "audio/mpeg")
        self.assertEqual(resp.content, b"MP3DATA")
        # The degradation is stated, not silent.
        self.assertEqual(resp.headers["x-stream"], "full-body")
        self.assertIn("pcm_24000", resp.headers["x-stream-fallback"])
        # It went through the drop-in route's path, so it carries that route's
        # timing headers — which the real streaming path cannot emit at all.
        self.assertIn("x-synth-seconds", resp.headers)

    def test_pcm_and_wav_still_really_stream(self) -> None:
        """The fallback is mp3-ONLY: the streaming formats keep streaming."""
        for fmt in ("pcm_24000", "wav_24000"):
            with self.subTest(output_format=fmt):
                appmod.ENGINE = fake_engine.FakeEngine()
                with self.client.stream(
                    "POST", "/v1/text-to-speech/alba/stream",
                    params={"output_format": fmt},
                    json={"text": "Anything."},
                ) as resp:
                    self.assertEqual(resp.headers["x-stream"], "true")
                    self.assertNotIn("x-stream-fallback", resp.headers)
                    resp.read()

    def test_midstream_failure_truncates_logs_and_abandons(self) -> None:
        # Segment 2 of 3 fails after segment 1 has already been yielded: the
        # stream must truncate (status is committed — no other signal exists),
        # the failure must be LOGGED with a request id (it was a fully silent
        # swallow before), and the never-consumed tail job must be marked
        # abandoned so workers skip it un-run (the `jobs[consumed:]` cleanup,
        # previously unverified for consumed > 0).
        eng = fake_engine.FakeEngine(
            workers=1, delay=0.02, errors={"Two.": "segment exploded"})
        appmod.ENGINE = eng

        async def _drive():
            resp = await appmod.text_to_speech_stream(
                "alba", TTSRequest(text="One. Two. Three."),
                output_format="pcm_24000", emotion=None)
            chunks = []
            async for chunk in resp.body_iterator:
                if chunk:
                    chunks.append(chunk)
            return chunks

        with self.assertLogs("gravitone", level="ERROR") as captured:
            chunks = asyncio.run(_drive())
        eng.close()

        self.assertEqual(len(chunks), 1)  # seg 1 delivered, then truncation
        self.assertEqual(len(chunks[0]), 480)
        joined = "\n".join(captured.output)
        self.assertIn("stream segment 2/3 failed [request ", joined)
        self.assertIn("segment exploded", joined)
        # consumed == 1, so jobs[1:] (the failed job and the never-read tail)
        # must both be abandoned; the delivered one must not.
        self.assertFalse(eng.jobs[0].abandoned.is_set())
        self.assertTrue(eng.jobs[1].abandoned.is_set())
        self.assertTrue(eng.jobs[2].abandoned.is_set())

    def test_whole_request_deadline_counts_and_truncates(self) -> None:
        # ONE deadline bounds the whole response (it used to be
        # request_timeout_s per segment, so an N-segment stream could run N ×
        # 120s). Exceeding it must increment the same timeout metric the
        # non-stream path counts and truncate the stream.
        eng = fake_engine.FakeEngine(
            workers=1, delays={"One.": 0.01, "Two.": 0.6, "Three.": 0.01})
        appmod.ENGINE = eng
        orig_settings = appmod.SETTINGS  # frozen dataclass — swap a copy in
        appmod.SETTINGS = dataclasses.replace(orig_settings,
                                              stream_deadline_s=0.15)

        async def _drive():
            resp = await appmod.text_to_speech_stream(
                "alba", TTSRequest(text="One. Two. Three."),
                output_format="pcm_24000", emotion=None)
            return [c async for c in resp.body_iterator if c]

        try:
            with self.assertLogs("gravitone", level="ERROR") as captured:
                chunks = asyncio.run(_drive())
        finally:
            appmod.SETTINGS = orig_settings
            eng.close()

        self.assertEqual(len(chunks), 1)
        self.assertEqual(eng.metrics.timeouts, 1)
        self.assertIn("stream deadline (0.15s) exceeded at segment 2/3",
                      "\n".join(captured.output))

    def test_backpressure_returns_429_before_streaming(self) -> None:
        # capacity 1 but a 2-segment window -> the second submit of the FIRST
        # window is rejected up front, before any byte is committed.
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delay=0.02, capacity=1)
        resp = self.client.post(
            "/v1/text-to-speech/alba/stream",
            params={"output_format": "pcm_24000"},
            json={"text": "First one. Second one."},
        )
        self.assertEqual(resp.status_code, 429)
        self.assertEqual(resp.headers["retry-after"], "1")
        # 429 means NO body was streamed: backpressure never truncates.
        self.assertNotIn("x-stream", resp.headers)


class RollingWindowTests(unittest.TestCase):
    """Script length must not decide admission.

    Submitting every sentence up front capped a script at the pool's admission
    window (workers + queue_max = 33 by default): anything longer was a
    guaranteed 429 before a byte streamed. Segments are now submitted in a
    bounded rolling window instead.
    """

    def setUp(self) -> None:
        self._orig = appmod.ENGINE
        self._orig_settings = appmod.SETTINGS
        appmod.SETTINGS = dataclasses.replace(appmod.SETTINGS, chunk_chars=1)
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        eng = appmod.ENGINE
        if isinstance(eng, fake_engine.FakeEngine):
            eng.close()
        appmod.ENGINE = self._orig
        appmod.SETTINGS = self._orig_settings

    def test_200_sentence_script_streams_to_completion(self) -> None:
        # Default config: workers=1, queue_max=32 -> 33 admission slots. This
        # script is 200 segments; up-front submission made it a certain 429.
        eng = fake_engine.FakeEngine(workers=1, delay=0.0, capacity=33)
        appmod.ENGINE = eng
        text = " ".join(f"Sentence number {i}." for i in range(200))
        with self.client.stream(
            "POST", "/v1/text-to-speech/alba/stream",
            params={"output_format": "pcm_24000"},
            json={"text": text},
        ) as resp:
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.headers["x-stream-segments"], "200")
            body = resp.read()
        # Every segment delivered, none dropped.
        self.assertEqual(len(body), 200 * 480)
        self.assertEqual(len(eng.jobs), 200)

    def test_window_bounds_concurrent_admission(self) -> None:
        # capacity 2 == the auto window (workers=1 -> 2). A 10-segment script
        # completes anyway, which is only possible if the stream never holds
        # more than the window in the engine at once.
        eng = fake_engine.FakeEngine(workers=1, delay=0.0, capacity=2)
        appmod.ENGINE = eng
        text = " ".join(f"Line {i}." for i in range(10))
        with self.client.stream(
            "POST", "/v1/text-to-speech/alba/stream",
            params={"output_format": "pcm_24000"},
            json={"text": text},
        ) as resp:
            self.assertEqual(resp.status_code, 200)
            body = resp.read()
        self.assertEqual(len(body), 10 * 480)
        self.assertEqual(eng.submit_order,
                         [f"Line {i}." for i in range(10)])  # in order

    def test_segments_stream_in_request_order(self) -> None:
        eng = fake_engine.FakeEngine(workers=3, delays={
            "Alpha.": 0.12, "Beta.": 0.01, "Gamma.": 0.01})
        appmod.ENGINE = eng
        with self.client.stream(
            "POST", "/v1/text-to-speech/alba/stream",
            params={"output_format": "pcm_24000"},
            json={"text": "Alpha. Beta. Gamma."},
        ) as resp:
            body = resp.read()
        # Alpha is the slowest yet must still be the first 480 bytes.
        for i, job in enumerate(eng.jobs):
            self.assertEqual(body[i * 480:(i + 1) * 480],
                             job.future.result().wav_bytes[44:],
                             f"segment {i} out of order")


if __name__ == "__main__":
    unittest.main()
