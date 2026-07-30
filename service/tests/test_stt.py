"""Local speech-to-text — the plumbing around the model, not the model.

faster-whisper is replaced with a recording stand-in here, so these cases run
offline in milliseconds and assert the things this service is responsible for:
that configuration reaches the decoder, that a caller's hotwords and language
survive the trip, that the HTTP surface holds the ElevenLabs Scribe shape, and
that the two places this implementation is WEAKER than Scribe say so out loud
instead of pretending.

The real round trip (synthesize a sentence, hear it back) needs ~460 MB of
weights, so it is opt-in: set ``GRAVITONE_STT_E2E=1`` to run it.
"""
from __future__ import annotations

import dataclasses
import io
import os
import sys
import types
import unittest

import numpy as np

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod  # noqa: E402
from service import stt  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class _Word:
    def __init__(self, word: str, start: float, end: float):
        self.word, self.start, self.end = word, start, end


class _Segment:
    def __init__(self, text: str, words=None):
        self.text, self.words = text, words or []


class _Info:
    def __init__(self, language="en", probability=0.99, duration=2.0):
        self.language = language
        self.language_probability = probability
        self.duration = duration


class _FakeModel:
    """Records how it was built and how it was called."""

    built: list[tuple] = []
    calls: list[dict] = []
    text = "React and PostgreSQL."
    words = True

    def __init__(self, name, **kwargs):
        type(self).built.append((name, kwargs))
        self.name = name

    def transcribe(self, audio, **kwargs):
        type(self).calls.append(dict(kwargs, audio=audio))
        words = ([_Word("React", 0.0, 0.4), _Word("and", 0.4, 0.6),
                  _Word("PostgreSQL.", 0.6, 1.2)] if kwargs.get("word_timestamps")
                 else [])
        # A generator, like the real one: the work happens on iteration, which
        # is why service.stt materializes it inside its lock.
        return (s for s in [_Segment(type(self).text, words)]), _Info()


def _install_fake(monkey: dict) -> None:
    module = types.ModuleType("faster_whisper")
    module.WhisperModel = _FakeModel
    audio_mod = types.ModuleType("faster_whisper.audio")
    audio_mod.decode_audio = lambda f, sampling_rate=16000: np.zeros(
        int(sampling_rate * 2.0), dtype=np.float32)
    module.audio = audio_mod
    monkey["faster_whisper"] = sys.modules.get("faster_whisper")
    monkey["faster_whisper.audio"] = sys.modules.get("faster_whisper.audio")
    sys.modules["faster_whisper"] = module
    sys.modules["faster_whisper.audio"] = audio_mod


class _FakeWhisperCase(unittest.TestCase):
    def setUp(self) -> None:
        self._monkey: dict = {}
        _install_fake(self._monkey)
        _FakeModel.built.clear()
        _FakeModel.calls.clear()
        _FakeModel.text = "React and PostgreSQL."
        self._orig_settings = stt.SETTINGS
        stt._MODEL = None
        stt._MODEL_KEY = None

    def tearDown(self) -> None:
        for name, prev in self._monkey.items():
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev
        stt.SETTINGS = self._orig_settings
        stt._MODEL = None
        stt._MODEL_KEY = None


class ModelLifecycleTests(_FakeWhisperCase):
    def test_the_model_is_built_from_configuration(self) -> None:
        stt.SETTINGS = dataclasses.replace(stt.SETTINGS, stt_model="small",
                                           stt_compute_type="int8", stt_threads=3)
        stt.load_model()
        name, kwargs = _FakeModel.built[-1]
        self.assertEqual(name, "small")
        self.assertEqual(kwargs["compute_type"], "int8")
        self.assertEqual(kwargs["cpu_threads"], 3)
        # download_root is only passed when an operator set one; passing "" would
        # point the cache at the process's working directory.
        self.assertNotIn("download_root", kwargs)

    def test_a_download_root_is_honoured_when_set(self) -> None:
        stt.SETTINGS = dataclasses.replace(stt.SETTINGS, stt_download_root="/models")
        stt.load_model()
        self.assertEqual(_FakeModel.built[-1][1]["download_root"], "/models")

    def test_the_model_is_loaded_once_and_kept_hot(self) -> None:
        stt.load_model()
        stt.load_model()
        self.assertEqual(len(_FakeModel.built), 1)

    def test_changing_the_model_reloads_it(self) -> None:
        stt.load_model()
        stt.SETTINGS = dataclasses.replace(stt.SETTINGS, stt_model="tiny")
        stt.load_model()
        self.assertEqual([b[0] for b in _FakeModel.built], ["small", "tiny"])

    def test_a_missing_library_says_what_to_install(self) -> None:
        sys.modules["faster_whisper"] = None  # makes `import faster_whisper` raise
        with self.assertRaises(stt.SttUnavailable) as caught:
            stt.load_model()
        self.assertIn("pip install", str(caught.exception))
        self.assertFalse(stt.available())

    def test_info_reports_the_ear_without_loading_it(self) -> None:
        described = stt.info()
        self.assertFalse(described["loaded"])
        self.assertIs(described["diarization"], False)
        self.assertEqual(_FakeModel.built, [])


class TranscribeTests(_FakeWhisperCase):
    def test_a_transcript_carries_text_language_and_cost(self) -> None:
        result = stt.transcribe(np.zeros(16000, dtype=np.float32))
        self.assertEqual(result.text, "React and PostgreSQL.")
        self.assertEqual(result.language_code, "en")
        self.assertEqual(result.language_probability, 0.99)
        self.assertEqual(result.duration_s, 2.0)
        self.assertGreaterEqual(result.transcribe_s, 0.0)

    def test_the_realtime_factor_is_audio_over_compute(self) -> None:
        made = stt.Transcript(text="x", language_code="en", language_probability=1.0,
                              duration_s=6.0, transcribe_s=2.0)
        self.assertEqual(made.realtime_factor(), 3.0)
        # A transcription too fast to have measured is reported as unknown
        # rather than as a division by zero.
        self.assertIsNone(dataclasses.replace(made, transcribe_s=0.0).realtime_factor())

    def test_hotwords_and_language_reach_the_decoder(self) -> None:
        """The whole point of a local transcriber: per-request term bias.

        The cloud agent needed a keyword list configured on the dashboard to
        stop hearing "React" as "Rust", and the browser SDK could not set one
        per session at all.
        """
        stt.transcribe(np.zeros(16000, dtype=np.float32), language="cs",
                       hotwords="React PostgreSQL")
        call = _FakeModel.calls[-1]
        self.assertEqual(call["language"], "cs")
        self.assertEqual(call["hotwords"], "React PostgreSQL")

    def test_empty_bias_is_sent_as_nothing_not_as_empty_string(self) -> None:
        stt.transcribe(np.zeros(16000, dtype=np.float32), language="", hotwords="")
        call = _FakeModel.calls[-1]
        self.assertIsNone(call["language"])
        self.assertIsNone(call["hotwords"])

    def test_silence_is_guarded_against_hallucination(self) -> None:
        """Whisper's documented failure on an empty room is to invent a caption."""
        stt.transcribe(np.zeros(16000, dtype=np.float32))
        call = _FakeModel.calls[-1]
        self.assertTrue(call["vad_filter"])
        self.assertFalse(call["condition_on_previous_text"])

    def test_a_conversational_turn_skips_word_timestamps(self) -> None:
        stt.transcribe_pcm(b"\x00\x00" * 16000)
        self.assertFalse(_FakeModel.calls[-1]["word_timestamps"])

    def test_pcm_becomes_normalized_float(self) -> None:
        pcm = np.array([0, 16384, -32768], dtype="<i2").tobytes()
        out = stt.pcm16_to_float32(pcm)
        self.assertEqual(out.dtype, np.float32)
        np.testing.assert_allclose(out, [0.0, 0.5, -1.0], atol=1e-6)

    def test_off_rate_audio_is_resampled_rather_than_refused(self) -> None:
        result = stt.transcribe_pcm(b"\x00\x00" * 8000, rate=8000)
        self.assertEqual(result.text, "React and PostgreSQL.")

    def test_an_empty_room_transcribes_to_nothing(self) -> None:
        _FakeModel.text = "   "
        self.assertEqual(stt.transcribe_pcm(b"\x00\x00" * 16000).text, "")


class PartialDecodeTests(_FakeWhisperCase):
    """Partials are subordinate to every real decode, and say so by returning None.

    The policy is the feature: a partial that runs when it should not have is
    CPU stolen from the turn the caller is actually waiting for, so every way of
    declining is asserted here — and each one is counted, because a speculation
    nobody can measure cannot be tuned or switched off with evidence.
    """

    def setUp(self) -> None:
        super().setUp()
        self._orig_partials = stt.partial_stats()
        self._orig_finals = stt._FINALS_WAITING
        for key in stt._PARTIALS:
            stt._PARTIALS[key] = 0

    def tearDown(self) -> None:
        stt._PARTIALS.update(self._orig_partials)
        stt._FINALS_WAITING = self._orig_finals
        super().tearDown()

    def _pcm(self, samples: int = 16000) -> bytes:
        return b"\x00\x00" * samples

    def test_a_partial_is_greedy_and_carries_no_word_timing(self) -> None:
        """It exists to be cheap: a beam search and word timestamps are both
        things only the final decode can justify."""
        stt.load_model()
        result = stt.transcribe_partial(self._pcm())
        self.assertIsNotNone(result)
        call = _FakeModel.calls[-1]
        self.assertEqual(call["beam_size"], 1)
        self.assertFalse(call["word_timestamps"])
        # And it keeps the anti-hallucination guards a final decode has: partial
        # text is noisy enough already.
        self.assertTrue(call["vad_filter"])
        self.assertFalse(call["condition_on_previous_text"])
        self.assertEqual(stt.partial_stats()["run"], 1)

    def test_bias_and_language_reach_a_partial_too(self) -> None:
        stt.load_model()
        stt.transcribe_partial(self._pcm(), language="cs", hotwords="React")
        call = _FakeModel.calls[-1]
        self.assertEqual((call["language"], call["hotwords"]), ("cs", "React"))

    def test_a_cold_model_is_not_loaded_for_a_guess(self) -> None:
        """A ~2 s model load inside the audio path would make the very turn this
        is supposed to accelerate arrive late."""
        self.assertIsNone(stt.transcribe_partial(self._pcm()))
        self.assertEqual(_FakeModel.built, [])
        self.assertEqual(stt.partial_stats()["dropped_cold"], 1)

    def test_a_waiting_final_wins_outright(self) -> None:
        stt.load_model()
        _FakeModel.calls.clear()
        stt._FINALS_WAITING = 1
        try:
            self.assertIsNone(stt.transcribe_partial(self._pcm()))
        finally:
            stt._FINALS_WAITING = 0
        self.assertEqual(_FakeModel.calls, [])
        self.assertEqual(stt.partial_stats()["dropped_for_final"], 1)

    def test_a_held_run_lock_is_never_waited_on(self) -> None:
        stt.load_model()
        _FakeModel.calls.clear()
        self.assertTrue(stt._RUN_LOCK.acquire(blocking=False))
        try:
            self.assertIsNone(stt.transcribe_partial(self._pcm()))
        finally:
            stt._RUN_LOCK.release()
        self.assertEqual(_FakeModel.calls, [])
        self.assertEqual(stt.partial_stats()["dropped_busy"], 1)

    def test_a_partial_releases_the_lock_it_took(self) -> None:
        stt.load_model()
        stt.transcribe_partial(self._pcm())
        self.assertTrue(stt._RUN_LOCK.acquire(blocking=False))
        stt._RUN_LOCK.release()

    def test_an_empty_clip_is_not_a_decode(self) -> None:
        stt.load_model()
        _FakeModel.calls.clear()
        self.assertIsNone(stt.transcribe_partial(b""))
        self.assertEqual(_FakeModel.calls, [])

    def test_off_rate_audio_is_resampled_for_a_partial_as_well(self) -> None:
        stt.load_model()
        self.assertIsNotNone(stt.transcribe_partial(self._pcm(8000), rate=8000))

    def test_a_final_conversational_decode_declares_itself_waiting(self) -> None:
        """The signal a partial reads. Only true WHILE a final is in flight."""
        seen: list[bool] = []
        original = _FakeModel.transcribe

        def _watching(self, audio, **kwargs):
            seen.append(stt.final_is_waiting())
            return original(self, audio, **kwargs)

        _FakeModel.transcribe = _watching
        try:
            stt.transcribe_pcm(self._pcm())
        finally:
            _FakeModel.transcribe = original
        self.assertEqual(seen, [True])
        self.assertFalse(stt.final_is_waiting())

    def test_the_stats_are_a_copy_and_not_the_live_dict(self) -> None:
        snapshot = stt.partial_stats()
        snapshot["run"] = 999
        self.assertEqual(stt.partial_stats()["run"], 0)

    def test_the_ear_reports_its_partial_activity(self) -> None:
        stt.load_model()
        stt.transcribe_partial(self._pcm())
        self.assertEqual(stt.info()["partials"]["run"], 1)


class HttpSurfaceTests(_FakeWhisperCase):
    def setUp(self) -> None:
        super().setUp()
        self.client = TestClient(appmod.app)

    def _post(self, content: bytes = b"RIFFfake", **data):
        return self.client.post("/v1/speech-to-text",
                                files={"file": ("clip.wav", io.BytesIO(content),
                                                "audio/wav")},
                                data=data)

    def test_the_response_holds_the_scribe_shape(self) -> None:
        body = self._post().json()
        for key in ("language_code", "language_probability", "text", "words"):
            self.assertIn(key, body)
        self.assertEqual(body["text"], "React and PostgreSQL.")
        first = body["words"][0]
        self.assertEqual((first["text"], first["type"], first["speaker_id"]),
                         ("React", "word", "speaker_0"))

    def test_a_whole_recording_spends_the_beam(self) -> None:
        """Nothing is waiting on a file the way a turn waits on a sentence."""
        self._post()
        self.assertGreaterEqual(_FakeModel.calls[-1]["beam_size"], 5)

    def test_not_asking_for_diarization_leaves_every_word_unattributed(self) -> None:
        """``speaker_0`` everywhere is the admission that nobody was separated,
        not a claim that one speaker was detected."""
        body = self._post(diarize="false").json()
        self.assertEqual(body["diarization"], {"requested": False})
        self.assertTrue(all(w["speaker_id"] == "speaker_0" for w in body["words"]))

    def test_asking_for_diarization_reports_what_it_managed(self) -> None:
        """Structural, not model-dependent: this box may or may not have the
        diarization models, and either way the payload has to be readable."""
        block = self._post(diarize="true").json()["diarization"]
        self.assertTrue(block["requested"])
        self.assertIn("available", block)
        if block["available"]:
            self.assertIn("speakers", block)
            if block["speakers"]:
                # Whenever a count is offered, the caveat travels with it.
                self.assertTrue(block["speaker_count_is_a_hypothesis"])
                self.assertIn("threshold", block)
        else:
            # A missing library or model says what to do about it.
            self.assertTrue(block["detail"])

    def test_a_diarization_failure_does_not_lose_the_transcript(self) -> None:
        """Diarization is an enrichment. A recording that could be transcribed
        but not split is still worth returning."""
        from service import diarize as diarizer

        def _boom(*a, **k):
            raise RuntimeError("clustering exploded")

        original = diarizer.diarize
        diarizer.diarize = _boom
        try:
            body = self._post(diarize="true").json()
        finally:
            diarizer.diarize = original
        self.assertEqual(body["text"], "React and PostgreSQL.")  # transcript intact
        self.assertFalse(body["diarization"]["available"])
        self.assertIn("RuntimeError", body["diarization"]["detail"])

    def test_keywords_are_forwarded_as_bias(self) -> None:
        self._post(keywords="Kubernetes Terraform")
        self.assertEqual(_FakeModel.calls[-1]["hotwords"], "Kubernetes Terraform")

    def test_an_empty_upload_is_refused(self) -> None:
        self.assertEqual(self._post(content=b"").status_code, 400)

    def test_an_oversized_upload_is_refused_before_decoding(self) -> None:
        res = self._post(content=b"x" * (stt.MAX_UPLOAD_BYTES + 1))
        self.assertEqual(res.status_code, 413)
        self.assertEqual(_FakeModel.calls, [])

    def test_a_recording_over_the_duration_limit_is_refused(self) -> None:
        stt.SETTINGS = dataclasses.replace(stt.SETTINGS, stt_max_clip_seconds=1.0)
        res = self._post()  # the stub decodes to 2.0s
        self.assertEqual(res.status_code, 413)

    def test_audio_that_will_not_decode_says_which_formats_work(self) -> None:
        def _boom(*a, **k):
            raise ValueError("not audio")

        sys.modules["faster_whisper.audio"].decode_audio = _boom
        res = self._post()
        self.assertEqual(res.status_code, 400)
        self.assertIn("wav", res.json()["detail"])

    def test_a_missing_library_is_a_503_not_a_500(self) -> None:
        """The capability is absent; the request was not wrong."""
        sys.modules["faster_whisper"] = None
        sys.modules.pop("faster_whisper.audio", None)
        self.assertEqual(self._post().status_code, 503)


if __name__ == "__main__":
    unittest.main()
