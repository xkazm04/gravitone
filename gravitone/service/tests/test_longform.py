"""Long-form segmentation on the drop-in route (POST /v1/text-to-speech/{id}).

The batch path submits every unit at the SAME instant, so its unit count is an
admission cost that only pays for itself when there are workers to absorb it.
These cases pin all three regimes:

  * `workers=1` — THE SHIPPED TOPOLOGY (config default, and replicas.py pins
    TTS_WORKERS=1 into every child). No parallelism exists, so no body is ever
    split on this route: one job, one admission slot, no concat, no seams, the
    pre-segmentation bytes and headers. `SingleWorkerTopologyTests`.
  * `workers=N` — an operator who really did raise TTS_WORKERS. Split into at
    most N units, submitted as one batch, occupying N workers at once, re-joined
    in request order by the engine's own `concat_wavs`, reporting wall-clock
    (not summed) synth time, and 429ing as a whole batch — abandoning the
    siblings that already got in. `MultiWorkerBatchTests`.
  * a short body is ONE job under every setting (the regression pin).

Every case that wants a batch sets `SETTINGS.workers` ITSELF, alongside the
FakeEngine's pool size. An earlier round configured only the fake, so it proved
concurrency against a topology the product does not ship.
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
        # The synthesis cache is a process-wide singleton: without this, a case
        # that re-uses another case's (voice, text, settings) is served from the
        # previous test's engine and asserts nothing.
        appmod.SYNTH_CACHE.clear()
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        eng = appmod.ENGINE
        if isinstance(eng, fake_engine.FakeEngine):
            eng.close()
        appmod.ENGINE = self._orig_engine
        appmod.SETTINGS = self._orig_settings

    def _configure(self, **kw) -> None:
        appmod.SETTINGS = dataclasses.replace(appmod.SETTINGS, **kw)

    def _chunk_every_sentence(self, workers: int) -> None:
        """Budget of 1 char -> every sentence is its own synthesis unit.

        ``workers`` is NOT optional: the batch cap is derived from the process's
        real parallelism, so a case that wants N units must say it is running a
        TTS_WORKERS=N deployment (and give the fake a matching pool).
        """
        self._configure(chunk_chars=1, workers=workers)

    def _post(self, text: str, **json_extra):
        return self.client.post(
            "/v1/text-to-speech/alba", params={"output_format": "wav_24000"},
            json={"text": text, **json_extra})

    @staticmethod
    def _body_of_sentences(sentence_len: int, total: int) -> str:
        """Exactly `total` chars of sentences each `sentence_len` long.

        The remainder becomes one shorter trailing sentence, so the fixture is
        a genuine max-length body however the length divides.
        """
        def _sentence(n: int) -> str:
            return "w" * (n - 1) + "."

        count = (total + 1) // (sentence_len + 1)  # +1 for the joining space
        sentences = [_sentence(sentence_len)] * count
        rest = total - (count * (sentence_len + 1) - 1)
        if rest >= 5:  # +1 space, so the tail sentence is rest-1 chars
            sentences.append(_sentence(rest - 1))
        return " ".join(sentences)


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

    def test_batch_cap_tracks_workers_not_the_queue_depth(self) -> None:
        """The cap is parallelism, and only parallelism.

        `workers + queue_max` is a QUEUE-DEPTH knob. Deriving the cap from it
        meant (a) 16 units on a process with ONE worker, which run serially
        anyway, and (b) raising queue_max for backpressure headroom silently
        raising how much of that headroom one caller could claim.
        """
        # Shipped default: one worker -> no split at all.
        self._configure(workers=1, queue_max=32)
        self.assertEqual(appmod._max_batch_units(), 1)
        # Deeper queue, same single worker: still 1. The knob is not parallelism.
        self._configure(workers=1, queue_max=512)
        self.assertEqual(appmod._max_batch_units(), 1)
        # A real pool: the cap is the pool size...
        self._configure(workers=4, queue_max=32)
        self.assertEqual(appmod._max_batch_units(), 4)
        # ...bounded by _MAX_BATCH_UNITS (seams/overhead)...
        self._configure(workers=64, queue_max=512)
        self.assertEqual(appmod._max_batch_units(), appmod._MAX_BATCH_UNITS)
        # ...and by half the admission window, so one caller never takes it all.
        self._configure(workers=8, queue_max=0)
        self.assertEqual(appmod._max_batch_units(), 4)

    def test_max_length_body_never_outgrows_the_batch_cap(self) -> None:
        """The unit count of a BATCHED request is bounded, for real.

        The fixed char budget alone does not bound it: greedy coalescing only
        merges when the COMBINED length fits, so any sentence longer than half
        the budget stays its own unit. At a 350-char budget an 8000-char body
        of ~180-char sentences (ordinary prose) produced 44 units against a
        33-slot admission window — i.e. a guaranteed 429 on a route that used
        to submit exactly one job. The lengths below are the ones that broke it.

        Run at workers=4, because that is the only topology where the batch path
        splits at all now; the workers=1 case is pinned in
        `SingleWorkerTopologyTests`.
        """
        self._configure(workers=4)
        max_units = appmod._max_batch_units()
        self.assertEqual(max_units, 4)
        window = appmod.SETTINGS.workers + appmod.SETTINGS.queue_max
        self.assertLessEqual(max_units, window // 2,
                             "one request must not claim the whole window")
        for sentence_len in (100, 176, 200, 250, 349, 800):
            with self.subTest(sentence_len=sentence_len):
                text = self._body_of_sentences(sentence_len, total=8000)
                self.assertGreaterEqual(len(text), 7800)
                self.assertLessEqual(len(text), 8000)  # the TTSRequest cap
                units = appmod._chunk_text(text, max_units=max_units)
                self.assertLessEqual(
                    len(units), max_units,
                    f"{sentence_len}-char sentences produced {len(units)} "
                    f"units for a {window}-slot window")
                # Widening the budget must not lose or reorder a single word.
                self.assertEqual(" ".join(units), text)

    def test_cap_of_one_returns_the_body_verbatim(self) -> None:
        """max_units=1 short-circuits to the un-segmented text.

        Not a re-join of split sentences, and not a widen loop that re-derives
        one: the caller (the shipped single-worker batch route) must get back
        exactly what it would have submitted with no segmentation at all.
        """
        text = self._body_of_sentences(176, total=8000)
        self.assertEqual(appmod._chunk_text(text, max_units=1), [text])
        self.assertEqual(appmod._chunk_text("  Alpha. Beta.  ", max_units=1),
                         ["Alpha. Beta."])

    def test_streaming_style_chunking_is_not_capped(self) -> None:
        # No max_units: the streaming route submits in a rolling window, so its
        # unit count costs no admission and finer units mean lower TTFB — a win
        # that holds at ANY worker count, so it is deliberately never capped.
        text = self._body_of_sentences(176, total=8000)
        uncapped = appmod._chunk_text(text)
        self.assertGreater(len(uncapped), 1)
        self.assertEqual(" ".join(uncapped), text)
        for workers in (1, 4):
            with self.subTest(workers=workers):
                self._configure(workers=workers)
                capped = appmod._chunk_text(
                    text, max_units=appmod._max_batch_units())
                self.assertGreater(len(uncapped), len(capped))


class SingleWorkerTopologyTests(_Base):
    """The SHIPPED default: TTS_WORKERS=1, the only value replicas.py spawns.

    One worker cannot run two units at once, so the batch path must cost this
    replica nothing: no extra admission slots, no concat, no per-unit overhead
    for a concurrency it will never get.
    """

    def setUp(self) -> None:
        super().setUp()
        # Explicit, not inherited from the environment: this class IS the
        # shipped-topology pin. chunk_chars stays at the production budget.
        self._configure(workers=1)
        self.assertEqual(appmod.SETTINGS.workers, 1)

    def test_a_max_length_body_is_still_exactly_one_job(self) -> None:
        eng = fake_engine.FakeEngine(workers=1, delay=0.01)
        appmod.ENGINE = eng
        text = self._body_of_sentences(176, total=8000)
        # Sanity: this body DOES segment when nothing caps it (the streaming
        # route still sees ~46 units) — so a single job here is the cap acting,
        # not a fixture that happens to be short.
        self.assertGreater(len(appmod._chunk_text(text)), 16)

        resp = self._post(text)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(eng.jobs), 1, "a long body must not be batched")
        # The engine got the body VERBATIM — no re-join, no normalisation.
        self.assertEqual(eng.submit_order, [text])
        # ...and never occupied more than the one slot it is entitled to.
        self.assertEqual(eng.max_concurrent, 1)

    def test_long_body_returns_the_single_job_bytes_and_headers(self) -> None:
        eng = fake_engine.FakeEngine(workers=1, delay=0.05)
        appmod.ENGINE = eng
        resp = self._post(self._body_of_sentences(176, total=8000))
        self.assertEqual(resp.status_code, 200)
        # No concat pass: the body is the worker's WAV, byte for byte.
        self.assertEqual(resp.content, eng.jobs[0].future.result().wav_bytes)
        # The pre-segmentation headers, including the per-job synth time (a
        # batch would report request wall-clock instead).
        self.assertEqual(resp.headers["x-synth-seconds"], "0.05")
        self.assertEqual(resp.headers["x-queue-seconds"], "0.0")
        # No claim of segmentation that did not happen.
        self.assertNotIn("x-synth-segments", resp.headers)

    def test_long_body_does_not_hog_the_admission_window(self) -> None:
        """Admission cost is 1, so a near-full engine still serves long text.

        The old cap (min(16, (workers+queue_max)//2) = 16 on defaults) made this
        request claim 16 slots of the 33-slot window at once — on a replica that
        would run them one after another regardless. Here the engine has ONE
        free slot; a long body must fit in it.
        """
        eng = fake_engine.FakeEngine(workers=1, delay=0.01, capacity=1)
        appmod.ENGINE = eng
        resp = self._post(self._body_of_sentences(176, total=8000))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(eng.jobs), 1)

    def test_no_net_negative_overhead_versus_a_short_body(self) -> None:
        """A long body costs the SAME number of jobs as a short one: one.

        Batching a single-worker replica was pure loss — identical total model
        work, plus N-1 extra job setups, N-1 concat seams and N-1 admission
        slots. This pins that none of it is paid.
        """
        eng = fake_engine.FakeEngine(workers=1, delay=0.01)
        appmod.ENGINE = eng
        self.assertEqual(self._post("Hello world.").status_code, 200)
        short_jobs = len(eng.jobs)
        long_text = self._body_of_sentences(176, total=8000)
        self.assertEqual(self._post(long_text).status_code, 200)
        self.assertEqual(len(eng.jobs) - short_jobs, short_jobs,
                         "a long body cost more jobs than a short one")
        # Nothing was concatenated, on either request.
        self.assertEqual(eng.executed, ["Hello world.", long_text])


class MultiWorkerBatchTests(_Base):
    """TTS_WORKERS=N — NOT the shipped default, but a supported deployment.

    Every case sets SETTINGS.workers to match its FakeEngine pool, because the
    batch cap now reads the process's real parallelism. The batch path itself is
    unchanged and these are the contracts it always had.
    """

    def test_segments_concat_in_request_order(self) -> None:
        self._chunk_every_sentence(workers=3)
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
        self._chunk_every_sentence(workers=4)
        eng = fake_engine.FakeEngine(workers=4, delay=0.2)
        appmod.ENGINE = eng
        resp = self._post("One. Two. Three. Four.")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(eng.jobs), 4)
        self.assertGreaterEqual(eng.max_concurrent, 4)

    def test_synth_seconds_is_wall_clock_not_the_sum(self) -> None:
        self._chunk_every_sentence(workers=4)
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
        self._chunk_every_sentence(workers=2)
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
        self._chunk_every_sentence(workers=3)
        eng = fake_engine.FakeEngine(workers=3, delay=0.02,
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
        self._chunk_every_sentence(workers=2)
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
