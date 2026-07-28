"""Long-form parallelism on the drop-in route (POST /v1/text-to-speech/{id}).

Pins both halves of the contract:
  * a short body is still ONE job and returns exactly the bytes and headers it
    returned before segmentation existed (the regression pin), and
  * a multi-unit body is submitted as one batch, occupies N workers at once,
    is re-joined in request order by the engine's own `concat_wavs`, reports
    wall-clock (not summed) synth time, and 429s as a whole batch — abandoning
    the siblings that already got in.
"""
from __future__ import annotations

import dataclasses
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
from fastapi.testclient import TestClient


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_settings = appmod.SETTINGS
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        eng = appmod.ENGINE
        if isinstance(eng, fake_engine.FakeEngine):
            eng.close()
        appmod.ENGINE = self._orig_engine
        appmod.SETTINGS = self._orig_settings

    def _chunk_every_sentence(self) -> None:
        """Budget of 1 char -> every sentence is its own synthesis unit."""
        appmod.SETTINGS = dataclasses.replace(appmod.SETTINGS, chunk_chars=1)

    def _post(self, text: str, **json_extra):
        return self.client.post(
            "/v1/text-to-speech/alba", params={"output_format": "wav_24000"},
            json={"text": text, **json_extra})


class SingleUnitUnchangedTests(_Base):
    """Short text must take the pre-segmentation path, byte for byte."""

    def test_short_text_is_one_job_with_the_original_headers(self) -> None:
        eng = fake_engine.FakeEngine(workers=2, delay=0.05)
        appmod.ENGINE = eng
        resp = self._post("Hello world.")

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(eng.jobs), 1)
        self.assertEqual(eng.submit_order, ["Hello world."])
        # Body is the worker's WAV, untouched (no concat, no re-write).
        self.assertEqual(resp.content, eng.jobs[0].future.result().wav_bytes)
        # Headers are the per-job values the route has always reported.
        self.assertEqual(resp.headers["x-audio-seconds"], "1.0")
        self.assertEqual(resp.headers["x-synth-seconds"], "0.05")
        self.assertEqual(resp.headers["x-queue-seconds"], "0.0")
        self.assertEqual(resp.headers["x-realtime-factor"], "20.0")
        # ...and nothing was ADDED: the segmentation header only appears when
        # the body actually got segmented.
        self.assertNotIn("x-synth-segments", resp.headers)

    def test_text_without_sentence_punctuation_stays_one_unit(self) -> None:
        eng = fake_engine.FakeEngine(workers=2, delay=0.01)
        appmod.ENGINE = eng
        resp = self._post("no punctuation here at all")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(eng.jobs), 1)
        self.assertNotIn("x-synth-segments", resp.headers)


class SegmentationTests(_Base):
    def test_chunking_coalesces_to_the_budget(self) -> None:
        # 320 one-word sentences ("Word. " = 6 chars) — the raw sentence count
        # is way past the admission window, the coalesced unit count is not.
        text = "Word. " * 320
        units = appmod._chunk_text(text)
        self.assertLessEqual(len(units), 24)
        self.assertGreater(len(units), 1)
        for unit in units:
            self.assertLessEqual(len(unit), appmod.SETTINGS.chunk_chars)
        # Nothing is dropped or reordered.
        self.assertEqual(" ".join(units), text.strip())

    def test_segments_concat_in_request_order(self) -> None:
        self._chunk_every_sentence()
        eng = fake_engine.FakeEngine(workers=3, delay=0.02)
        appmod.ENGINE = eng
        resp = self._post("Alpha. Beta. Gamma.")

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(eng.submit_order, ["Alpha.", "Beta.", "Gamma."])
        self.assertEqual(resp.headers["x-synth-segments"], "3")
        # One WAV header + the three segments' samples, in submission order.
        self.assertEqual(resp.content[:4], b"RIFF")
        self.assertEqual(len(resp.content), 44 + 3 * 480)
        samples = resp.content[44:]
        for i, job in enumerate(eng.jobs):
            self.assertEqual(samples[i * 480:(i + 1) * 480],
                             job.future.result().wav_bytes[44:],
                             f"segment {i} out of order")

    def test_n_segments_occupy_n_workers_concurrently(self) -> None:
        self._chunk_every_sentence()
        eng = fake_engine.FakeEngine(workers=4, delay=0.2)
        appmod.ENGINE = eng
        resp = self._post("One. Two. Three. Four.")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(eng.jobs), 4)
        self.assertGreaterEqual(eng.max_concurrent, 4)

    def test_synth_seconds_is_wall_clock_not_the_sum(self) -> None:
        self._chunk_every_sentence()
        eng = fake_engine.FakeEngine(workers=4, delay=0.2)
        appmod.ENGINE = eng
        resp = self._post("One. Two. Three. Four.")
        self.assertEqual(resp.status_code, 200)
        synth = float(resp.headers["x-synth-seconds"])
        # Four 0.2s segments on four workers: the request took ~0.2s of
        # wall-clock, never the 0.8s a per-segment sum would claim.
        self.assertGreaterEqual(synth, 0.15)
        self.assertLess(synth, 0.6)
        # Audio duration, by contrast, IS the sum — it's a real total length.
        self.assertEqual(resp.headers["x-audio-seconds"], "4.0")
        self.assertEqual(resp.headers["x-realtime-factor"],
                         str(round(4.0 / synth, 3)))

    def test_batch_rejection_is_429_and_abandons_siblings(self) -> None:
        self._chunk_every_sentence()
        eng = fake_engine.FakeEngine(workers=2, delay=0.05, capacity=1)
        appmod.ENGINE = eng
        resp = self._post("First one. Second one.")
        self.assertEqual(resp.status_code, 429)
        self.assertEqual(resp.headers["retry-after"], "1")
        self.assertIn("queue", resp.json())
        # The segment that got in must not synthesize into a dead response.
        self.assertEqual(len(eng.jobs), 1)
        self.assertTrue(eng.jobs[0].abandoned.is_set())

    def test_segment_failure_abandons_the_whole_batch(self) -> None:
        self._chunk_every_sentence()
        eng = fake_engine.FakeEngine(workers=1, delay=0.02,
                                     errors={"Two.": "segment exploded"})
        appmod.ENGINE = eng
        client = TestClient(appmod.app, raise_server_exceptions=False)
        resp = client.post("/v1/text-to-speech/alba",
                           params={"output_format": "wav_24000"},
                           json={"text": "One. Two. Three."})
        self.assertEqual(resp.status_code, 500)
        self.assertTrue(resp.json()["detail"].startswith("synthesis failed ("))
        for i, job in enumerate(eng.jobs):
            self.assertTrue(job.abandoned.is_set(), f"job {i} not abandoned")

    def test_pcm_segmented_keeps_raw_samples_and_rate_header(self) -> None:
        self._chunk_every_sentence()
        eng = fake_engine.FakeEngine(workers=2, delay=0.01)
        appmod.ENGINE = eng
        resp = self.client.post(
            "/v1/text-to-speech/alba", params={"output_format": "pcm_24000"},
            json={"text": "Alpha. Beta."})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers["x-sample-rate"], "24000")
        self.assertEqual(resp.headers["x-synth-segments"], "2")
        self.assertNotEqual(resp.content[:4], b"RIFF")
        self.assertEqual(len(resp.content), 2 * 480)


if __name__ == "__main__":
    unittest.main()
