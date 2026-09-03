"""Speaker diarization — the label logic, and the honesty about its limits.

sherpa-onnx is stubbed here so the assertions are about the code this repo
owns: how arbitrary cluster ids become stable speaker names, how a word's
speaker is chosen when it straddles a turn boundary, and that nothing in the
payload ever claims the speaker count is settled.

The real models are opt-in, and they check the two things that actually matter —
that a labelled recording of REAL humans comes back with the right number of
people, and what happens at the hard end of the input space (``HardInputTests``:
crosstalk, a noise or music bed under the speech, six speakers, and non-speech).
Those tests assert the MEASURED behaviour including where it is wrong, because
that is what the module's table publishes and a table nothing re-checks rots:

    GRAVITONE_DIARIZE_E2E=1 python -m pytest service/tests/test_diarize.py -q -s
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
from service.tests import real_speech

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

    Fixtures are sherpa-onnx's own labelled samples, fetched beside the models
    by ``service.tests.real_speech`` (which returns None rather than raising, so
    an offline box skips instead of failing).
    """

    def _audio(self, name: str) -> "np.ndarray":
        if not diarize.available():
            self.skipTest("run `python -m service.diarize --download` first")
        path = real_speech.fixture(name)
        if path is None:
            self.skipTest(f"fixture {name} could not be fetched")
        return real_speech.read_mono16k(path)

    def _count(self, label: str, audio: "np.ndarray", expected: int) -> int:
        result = diarize.diarize(audio)
        found = len(result.speakers)
        print(f"\n  {label}: truth {expected}, found {found} "
              f"({len(result.turns)} turns, {len(audio) / diarize.TARGET_RATE:.1f}s "
              f"of audio, {result.diarize_s}s)")
        return found

    def _run(self, name: str, expected: int) -> None:
        result = diarize.diarize(self._audio(name))
        print(f"\n  {name}: expected {expected}, found {len(result.speakers)} "
              f"in {result.diarize_s}s")
        self.assertEqual(len(result.speakers), expected)
        self.assertEqual(result.speakers,
                         [f"speaker_{i}" for i in range(expected)])

    def test_two_real_speakers_are_two_speakers(self) -> None:
        self._run("1-two-speakers-en.wav", 2)

    def test_four_real_speakers_are_four_speakers(self) -> None:
        self._run("0-four-speakers-zh.wav", 4)

    def test_six_real_speakers_are_six_speakers(self) -> None:
        """Past the end of the old table, which stopped at four.

        Two real recordings back to back: six genuinely different people, no
        overlap. Four was where the measuring stopped, not where the model
        stops.
        """
        audio = np.concatenate([self._audio("0-four-speakers-zh.wav"),
                                self._audio("1-two-speakers-en.wav")])
        self.assertEqual(6, self._count("six real speakers (4zh + 2en)", audio, 6))


@unittest.skipUnless(E2E, "set GRAVITONE_DIARIZE_E2E=1 (needs the real models)")
class HardInputTests(unittest.TestCase):
    """The end of the input space the module's table did not reach.

    These assert what was MEASURED, including where the measurement is that the
    diarizer is wrong — a test that demanded the right answer here would fail
    every run and teach nothing. When one of these starts failing, the model got
    better (or worse) and the table in diarize.py needs re-measuring; the
    assertion messages say so.

    Provenance is load-bearing and is repeated in the docstring of every test
    that has a weak one: a summed noise bed is what a noise bed really is, while
    summed crosstalk is not what a room really does.
    """

    def _audio(self, name: str) -> "np.ndarray":
        if not diarize.available():
            self.skipTest("run `python -m service.diarize --download` first")
        path = real_speech.fixture(name)
        if path is None:
            self.skipTest(f"fixture {name} could not be fetched")
        return real_speech.read_mono16k(path)

    def _speakers(self, label: str, audio: "np.ndarray", truth: int) -> int:
        result = diarize.diarize(audio)
        print(f"\n  {label}: truth {truth} -> found {len(result.speakers)} "
              f"({len(result.turns)} turns)")
        return len(result.speakers)

    # -- a bed under the speech ---------------------------------------------
    def test_a_quiet_noise_bed_leaves_the_count_alone(self) -> None:
        speech = self._audio("1-two-speakers-en.wav")
        for snr in (30.0, 25.0):
            mixed = real_speech.at_snr(speech, real_speech.noise_bed(speech.size), snr)
            with self.subTest(snr_db=snr):
                self.assertEqual(2, self._speakers(f"hiss bed @{snr:g} dB SNR",
                                                   mixed, 2))

    def test_a_louder_noise_bed_collapses_two_people_into_one(self) -> None:
        """The finding worth having, and it is a failure, not a pass.

        At 20 dB SNR — audible hiss, nothing exotic — a two-person recording is
        reported as ONE person. That is the exact wrong answer this module was
        built to stop returning, arriving by a different road, and it is why a
        clone pipeline may not treat "one speaker" from a noisy recording as
        settled.

        Three noise draws, because the collapse is a level effect and not a
        property of one random sequence. 25 dB is deliberately NOT asserted here
        as a collapse: it is the knee, and one exploratory draw did collapse
        there — which the table records rather than rounding away.
        """
        speech = self._audio("1-two-speakers-en.wav")
        for seed in (11, 12, 13):
            mixed = real_speech.at_snr(
                speech, real_speech.noise_bed(speech.size, seed), 20.0)
            with self.subTest(noise_seed=seed):
                self.assertEqual(
                    1, self._speakers(f"hiss bed @20 dB SNR (seed {seed})", mixed, 2),
                    "the noise-bed row in diarize.py's table needs re-measuring")

    def test_a_tonal_music_bed_is_survivable_where_hiss_is_not(self) -> None:
        """Same level, different spectrum, opposite outcome — which is why the
        table says "noise bed" and "music bed" as two rows and not one."""
        speech = self._audio("1-two-speakers-en.wav")
        for snr in (10.0, 0.0):
            mixed = real_speech.at_snr(speech, real_speech.music_bed(speech.size), snr)
            with self.subTest(snr_db=snr):
                self.assertEqual(2, self._speakers(
                    f"music bed @{snr:g} dB SNR", mixed, 2))

    # -- overlapping speech --------------------------------------------------
    def test_two_voices_talking_over_each_other_are_over_counted(self) -> None:
        """CONSTRUCTED crosstalk: one recording summed with a rotated copy of
        itself, so the same two people speak throughout and the truth is still
        two. It is not a real co-located recording (no room, no shared
        microphone, nobody raising their voice), so this asserts the DIRECTION
        of the error — over-counting — and the table claims nothing more."""
        speech = self._audio("1-two-speakers-en.wav")
        rotated = np.concatenate([speech[speech.size // 2:], speech[:speech.size // 2]])
        found = self._speakers("crosstalk: 2 voices overlaid",
                               (0.5 * (speech + rotated)).astype(np.float32), 2)
        self.assertGreater(found, 2, "sustained overlap no longer over-counts — "
                                     "re-measure the crosstalk rows")

    def test_six_voices_talking_over_each_other_collapse(self) -> None:
        """The same construction in the other direction: overlap six people and
        the count falls to three. Over- and under-counting from one cause is why
        the table's summary sentence is about level, not about number."""
        en = self._audio("1-two-speakers-en.wav")
        zh = self._audio("0-four-speakers-zh.wav")
        n = min(en.size, zh.size)
        found = self._speakers("crosstalk: 6 voices overlaid",
                               (0.5 * (en[:n] + zh[:n])).astype(np.float32), 6)
        self.assertLess(found, 6, "overlaid speech no longer collapses — "
                                  "re-measure the crosstalk rows")

    # -- nothing to hear -----------------------------------------------------
    def test_steady_non_speech_invents_nobody(self) -> None:
        """A fan, a held chord, an empty file: nobody spoke, nobody is reported.
        Silence is already covered with a stub in LabellingTests; this is the
        real model."""
        if not diarize.available():
            self.skipTest("run `python -m service.diarize --download` first")
        n = diarize.TARGET_RATE * 20
        t = np.arange(n, dtype=np.float64) / diarize.TARGET_RATE
        flat = sum(np.sin(2 * np.pi * f * t) for f in (110.0, 164.8, 220.0, 329.6))
        for label, audio in (("white noise only", real_speech.noise_bed(n) * 0.05),
                             ("unmodulated tone only", flat.astype(np.float32) * 0.1),
                             ("digital silence", np.zeros(n, dtype=np.float32))):
            with self.subTest(input=label):
                self.assertEqual(0, self._speakers(label, audio, 0))

    def test_but_a_modulated_music_bed_invents_a_speaker_out_of_nothing(self) -> None:
        """The one that surprised the table, so it is written down.

        The SAME tonal bed, given a 0.5 Hz tremolo and no speech whatsoever,
        comes back as one speaker holding ~11 seconds of "turns". The
        segmentation model is reading the amplitude envelope, so slow
        modulation alone is enough to manufacture a person. Consequence for
        every consumer: "1 speaker" is not evidence that anybody spoke, which is
        one more reason `count_is_certain` is permanently False.

        Asserted at two levels, five times quieter apart, because the level is
        not what does it.
        """
        if not diarize.available():
            self.skipTest("run `python -m service.diarize --download` first")
        n = diarize.TARGET_RATE * 20
        for gain in (0.1, 0.02):
            with self.subTest(gain=gain):
                found = self._speakers(f"tremolo'd tonal bed x{gain}",
                                       real_speech.music_bed(n) * gain, 0)
                self.assertEqual(1, found,
                                 "the phantom-speaker row in diarize.py's table "
                                 "needs re-measuring")

    def test_the_count_is_never_claimed_to_be_certain_even_when_it_is_right(self) -> None:
        """`count_is_certain` is permanently False, and the rows above are why:
        the same audio plus a hiss gives a different, confident-looking answer.
        """
        result = diarize.diarize(self._audio("1-two-speakers-en.wav"))
        self.assertEqual(2, len(result.speakers))
        self.assertFalse(result.count_is_certain)


if __name__ == "__main__":
    unittest.main()
