"""Speaker diarization — the label logic, and the honesty about its limits.

sherpa-onnx is stubbed here so the assertions are about the code this repo
owns: how arbitrary cluster ids become stable speaker names, how a word's
speaker is chosen when it straddles a turn boundary, and that nothing in the
payload ever claims the speaker count is settled.

The real models are opt-in, and they check the thing that actually matters —
that a labelled two-speaker recording of REAL humans comes back as two people:

    GRAVITONE_DIARIZE_E2E=1 python -m unittest service.tests.test_diarize
"""
from __future__ import annotations

import dataclasses
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

import numpy as np

from service import diarize

E2E = os.environ.get("GRAVITONE_DIARIZE_E2E") == "1"


class _Seg:
    def __init__(self, start, end, speaker):
        self.start, self.end, self.speaker = start, end, speaker


class _Result(list):
    def sort_by_start_time(self):
        return sorted(self, key=lambda s: s.start)


class _FakePipeline:
    """Returns whatever segments the test asked for, and records the threshold."""

    made: list[float] = []
    segments: list[_Seg] = []

    def __init__(self, config):
        type(self).made.append(config.clustering.threshold)

    def process(self, audio):
        return _Result(type(self).segments)


def _install_fake(monkey: dict, *, threshold_holder=None) -> None:
    module = types.ModuleType("sherpa_onnx")

    def _cfg(name, fields):
        return type(name, (), {
            "__init__": lambda self, **kw: self.__dict__.update(
                {f: kw.get(f) for f in fields} | kw)})

    module.OfflineSpeakerSegmentationPyannoteModelConfig = _cfg("P", ["model"])
    module.OfflineSpeakerSegmentationModelConfig = _cfg("S", ["pyannote", "num_threads"])
    module.SpeakerEmbeddingExtractorConfig = _cfg("E", ["model", "num_threads"])
    module.FastClusteringConfig = _cfg("C", ["num_clusters", "threshold"])
    module.OfflineSpeakerDiarizationConfig = _cfg(
        "D", ["segmentation", "embedding", "clustering",
              "min_duration_on", "min_duration_off"])
    module.OfflineSpeakerDiarization = _FakePipeline
    monkey["sherpa_onnx"] = sys.modules.get("sherpa_onnx")
    sys.modules["sherpa_onnx"] = module


class _DiarizeCase(unittest.TestCase):
    def setUp(self) -> None:
        self._monkey: dict = {}
        _install_fake(self._monkey)
        _FakePipeline.made.clear()
        _FakePipeline.segments = []
        self._tmp = tempfile.TemporaryDirectory()
        self._orig = diarize.SETTINGS
        diarize.SETTINGS = dataclasses.replace(diarize.SETTINGS,
                                               diarize_models_dir=self._tmp.name)
        # Pretend the models are on disk; the fake pipeline never reads them.
        diarize.segmentation_path().parent.mkdir(parents=True, exist_ok=True)
        diarize.segmentation_path().write_bytes(b"onnx")
        diarize.embedding_path().write_bytes(b"onnx")
        diarize._PIPELINE = None
        diarize._PIPELINE_KEY = None

    def tearDown(self) -> None:
        for name, prev in self._monkey.items():
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev
        diarize.SETTINGS = self._orig
        diarize._PIPELINE = None
        diarize._PIPELINE_KEY = None
        self._tmp.cleanup()

    @staticmethod
    def audio(seconds: float = 5.0) -> np.ndarray:
        return np.zeros(int(diarize.TARGET_RATE * seconds), dtype=np.float32)


class LabellingTests(_DiarizeCase):
    def test_cluster_ids_are_renumbered_by_first_appearance(self) -> None:
        """The clusterer's ids are arbitrary and sparse.

        A real two-speaker recording came back labelled 0 and 8, which reads to a
        caller like six speakers went missing.
        """
        _FakePipeline.segments = [_Seg(0.0, 2.0, 8), _Seg(2.0, 4.0, 3),
                                  _Seg(4.0, 6.0, 8)]
        result = diarize.diarize(self.audio())
        self.assertEqual([t.speaker for t in result.turns],
                         ["speaker_0", "speaker_1", "speaker_0"])
        self.assertEqual(result.speakers, ["speaker_0", "speaker_1"])

    def test_turns_come_back_in_time_order(self) -> None:
        _FakePipeline.segments = [_Seg(4.0, 6.0, 1), _Seg(0.0, 2.0, 0)]
        turns = diarize.diarize(self.audio()).turns
        self.assertEqual([t.start for t in turns], [0.0, 4.0])
        # ...and the FIRST speaker in time is speaker_0, not the lowest cluster id.
        self.assertEqual(turns[0].speaker, "speaker_0")

    def test_a_turn_knows_its_own_length(self) -> None:
        self.assertEqual(diarize.Turn(1.25, 3.5, "speaker_0").seconds, 2.25)

    def test_silence_produces_no_speakers_rather_than_one(self) -> None:
        _FakePipeline.segments = []
        result = diarize.diarize(self.audio())
        self.assertEqual(result.turns, [])
        self.assertEqual(result.speakers, [])

    def test_empty_audio_is_not_sent_to_the_model(self) -> None:
        self.assertEqual(diarize.diarize(np.array([], dtype=np.float32)).turns, [])
        self.assertEqual(_FakePipeline.made, [])


class WordAssignmentTests(unittest.TestCase):
    """Choosing a word's speaker — where the interesting edge case lives."""

    def setUp(self) -> None:
        self.result = diarize.DiarizationResult(turns=[
            diarize.Turn(0.0, 5.0, "speaker_0"),
            diarize.Turn(5.0, 10.0, "speaker_1"),
        ])

    def test_a_word_inside_one_turn_belongs_to_it(self) -> None:
        self.assertEqual(self.result.speaker_at(1.0, 1.5), "speaker_0")
        self.assertEqual(self.result.speaker_at(7.0, 7.5), "speaker_1")

    def test_a_word_across_a_boundary_goes_to_whoever_said_most_of_it(self) -> None:
        """Midpoint containment is cheaper and wrong exactly here."""
        self.assertEqual(self.result.speaker_at(4.8, 5.6), "speaker_1")  # 0.2 vs 0.6
        self.assertEqual(self.result.speaker_at(4.4, 5.2), "speaker_0")  # 0.6 vs 0.2

    def test_a_word_in_a_gap_belongs_to_nobody(self) -> None:
        gapped = diarize.DiarizationResult(turns=[diarize.Turn(0.0, 2.0, "speaker_0")])
        self.assertIsNone(gapped.speaker_at(5.0, 5.5))
        self.assertIsNone(diarize.DiarizationResult().speaker_at(0.0, 1.0))


class HonestyTests(_DiarizeCase):
    def test_the_speaker_count_never_claims_to_be_certain(self) -> None:
        _FakePipeline.segments = [_Seg(0.0, 2.0, 0), _Seg(2.0, 4.0, 1)]
        self.assertFalse(diarize.diarize(self.audio()).count_is_certain)
        self.assertFalse(diarize.DiarizationResult().count_is_certain)

    def test_info_repeats_the_caveat_wherever_it_travels(self) -> None:
        self.assertTrue(diarize.info()["speaker_count_is_a_hypothesis"])

    def test_the_threshold_is_the_only_knob_and_it_reaches_the_clusterer(self) -> None:
        _FakePipeline.segments = [_Seg(0.0, 1.0, 0)]
        diarize.diarize(self.audio(), threshold=0.42)
        self.assertEqual(_FakePipeline.made[-1], 0.42)
        # There is deliberately no speaker-count parameter: sherpa-onnx's
        # num_clusters does not produce the number asked for, so an API that
        # offered one would be lying. See the module docstring.
        import inspect

        self.assertNotIn("num_speakers", inspect.signature(diarize.diarize).parameters)

    def test_changing_the_threshold_rebuilds_the_pipeline(self) -> None:
        _FakePipeline.segments = [_Seg(0.0, 1.0, 0)]
        diarize.diarize(self.audio(), threshold=0.5)
        diarize.diarize(self.audio(), threshold=0.5)
        self.assertEqual(len(_FakePipeline.made), 1)   # reused
        diarize.diarize(self.audio(), threshold=0.7)
        self.assertEqual(len(_FakePipeline.made), 2)   # rebuilt


class AvailabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._orig = diarize.SETTINGS
        diarize.SETTINGS = dataclasses.replace(diarize.SETTINGS,
                                               diarize_models_dir=self._tmp.name)
        diarize._PIPELINE = None

    def tearDown(self) -> None:
        diarize.SETTINGS = self._orig
        self._tmp.cleanup()

    def test_missing_models_say_how_to_get_them(self) -> None:
        self.assertFalse(diarize.models_present())
        self.assertFalse(diarize.available())
        monkey: dict = {}
        _install_fake(monkey)
        try:
            with self.assertRaises(diarize.DiarizationUnavailable) as caught:
                diarize.diarize(np.zeros(16000, dtype=np.float32))
            self.assertIn("--download", str(caught.exception))
        finally:
            for name, prev in monkey.items():
                if prev is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = prev

    def test_a_missing_library_says_what_to_install(self) -> None:
        Path(diarize.embedding_path()).write_bytes(b"x")
        diarize.segmentation_path().parent.mkdir(parents=True, exist_ok=True)
        diarize.segmentation_path().write_bytes(b"x")
        saved = sys.modules.get("sherpa_onnx")
        sys.modules["sherpa_onnx"] = None  # makes the import raise
        try:
            with self.assertRaises(diarize.DiarizationUnavailable) as caught:
                diarize.diarize(np.zeros(16000, dtype=np.float32))
            self.assertIn("pip install", str(caught.exception))
        finally:
            if saved is None:
                sys.modules.pop("sherpa_onnx", None)
            else:
                sys.modules["sherpa_onnx"] = saved


@unittest.skipUnless(E2E, "set GRAVITONE_DIARIZE_E2E=1 (needs the real models)")
class RealAudioTests(unittest.TestCase):
    """The claim that matters: real recorded humans are counted correctly.

    Fixtures are sherpa-onnx's own labelled samples. Put them beside the models
    as ``1-two-speakers-en.wav`` / ``0-four-speakers-zh.wav``; the test skips if
    they are absent rather than downloading during a test run.
    """

    def _run(self, name: str, expected: int) -> None:
        if not diarize.available():
            self.skipTest("run `python -m service.diarize --download` first")
        path = diarize.models_dir() / name
        if not path.is_file():
            self.skipTest(f"fixture {name} is not in {diarize.models_dir()}")
        from faster_whisper.audio import decode_audio

        result = diarize.diarize(decode_audio(str(path),
                                              sampling_rate=diarize.TARGET_RATE))
        print(f"\n  {name}: expected {expected}, found {len(result.speakers)} "
              f"in {result.diarize_s}s")
        self.assertEqual(len(result.speakers), expected)
        self.assertEqual(result.speakers,
                         [f"speaker_{i}" for i in range(expected)])

    def test_two_real_speakers_are_two_speakers(self) -> None:
        self._run("1-two-speakers-en.wav", 2)

    def test_four_real_speakers_are_four_speakers(self) -> None:
        self._run("0-four-speakers-zh.wav", 4)


if __name__ == "__main__":
    unittest.main()
