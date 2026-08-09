"""The fidelity loop — the pipeline measures the voice it is producing.

Three things are proven here, and the FIRST one is the reason the other two are
written the way they are:

  1. **The degrade path**, which every test here STATES rather than borrows from
     the machine. On a box without sherpa-onnx (or without the 29 MB embedding
     model) every runtime takes the unavailable branch, and that must produce a
     payload that NAMES the reason and changes nothing else: no dropped audio, no
     identity, no zeros standing in for a measurement that never happened. It is
     the shipped behaviour on any box that has not run
     `python -m service.diarize --download`, so it is the path most users are on
     — not an edge case. These tests used to rely on this box being such a box,
     which meant they passed by accident until the models were installed here and
     then failed — testing the environment instead of the branch. The absence is
     patched in now, so the degrade path is proven on developer machines that CAN
     run the real pipeline, which are precisely the ones that would otherwise
     never exercise it.
  2. **The measurement itself**, with a stubbed sherpa (`_fake_sherpa`) for the
     plumbing — the extractor is built from `diarize.embedding_path()` with the
     configured thread budget, audio is handed over at 16 kHz float32, the load
     is cached — and with SYNTHETIC embeddings for the judgement: a bystander
     voice is dropped, a merely-unusual segment is only flagged, and neither can
     empty a stem or strip a recording.
  3. **Closing the loop at commit**: an exported clone is synthesized, scored
     against the stem it came from, and the identity lands on the registry row —
     while a missing synthesizer or a missing embedder is reported per voice
     instead of failing the clone.
"""
from __future__ import annotations

import json
import math
import sys
import types
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from service import diarize, ingest, voiceprint
from service.emotions import BASELINE

#: The sentence a box without the embedder answers with. Stated here so the
#: degrade path is tested by assertion rather than by whatever this machine
#: happens to have installed.
_ABSENT_REASON = ("the speaker embedding model is not installed on this box")

DIM = 8


# ── fixtures ────────────────────────────────────────────────────────────────
def _write_wav(path: Path, frames: int = 24000, rate: int = 24000,
               width: int = 2, channels: int = 1, value: int = 1200) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        if width == 1:
            sample = bytes([128 + (value % 100)])
        else:
            sample = (value & 0xFFFF).to_bytes(2, "little") if width == 2 else \
                (value << 16).to_bytes(4, "little")
        w.writeframes(sample * channels * frames)


def _unit(*components: float) -> "np.ndarray":
    v = np.zeros(DIM, dtype=np.float32)
    for i, c in enumerate(components):
        v[i] = c
    return v / float(np.linalg.norm(v))


def _fake_sherpa(compute=None, built=None):
    """A stand-in `sherpa_onnx` exposing only what voiceprint touches."""
    mod = types.ModuleType("sherpa_onnx")

    class Config:
        def __init__(self, model, num_threads=1):
            self.model = model
            self.num_threads = num_threads

    class Stream:
        def __init__(self):
            self.rate = None
            self.waveform = None
            self.finished = False

        def accept_waveform(self, sample_rate, waveform):
            self.rate = sample_rate
            self.waveform = waveform

        def input_finished(self):
            self.finished = True

    class Extractor:
        def __init__(self, config):
            self.config = config
            if built is not None:
                built.append(config)

        def create_stream(self):
            return Stream()

        def compute(self, stream):
            if compute is not None:
                return compute(stream)
            # Deterministic and content-derived: identical audio embeds
            # identically, different audio does not.
            mean = float(np.mean(stream.waveform))
            return [math.cos(mean * 50.0), math.sin(mean * 50.0)] + [0.0] * (DIM - 2)

    mod.SpeakerEmbeddingExtractorConfig = Config
    mod.SpeakerEmbeddingExtractor = Extractor
    return mod


class _VoiceprintCase(unittest.TestCase):
    """Every test starts with a cold extractor cache — a module-level singleton
    leaking between tests would make the load-caching assertions vacuous."""

    def setUp(self) -> None:
        voiceprint._EXTRACTOR = None
        voiceprint._EXTRACTOR_KEY = None

    tearDown = setUp


# ── 1. availability + the named degrade ─────────────────────────────────────
class AvailabilityTests(_VoiceprintCase):
    def test_missing_sherpa_is_named_not_guessed(self) -> None:
        # A None entry in sys.modules is what an uninstallable import looks like.
        with mock.patch.dict(sys.modules, {"sherpa_onnx": None}):
            reason = voiceprint.unavailable_reason()
            self.assertFalse(voiceprint.available())
            with self.assertRaises(voiceprint.Unavailable) as caught:
                voiceprint.embed("nonexistent-does-not-matter.wav")
        self.assertIn("sherpa-onnx", reason or "")
        self.assertIn("pip install", reason or "")
        self.assertIn("sherpa-onnx", str(caught.exception))

    def test_missing_model_says_how_to_fetch_it(self) -> None:
        with TemporaryDirectory() as td, \
             mock.patch.dict(sys.modules, {"sherpa_onnx": _fake_sherpa()}), \
             mock.patch.object(diarize, "models_dir", lambda: Path(td)):
            reason = voiceprint.unavailable_reason()
            self.assertFalse(voiceprint.available())
            self.assertFalse(voiceprint.model_present())
            src = Path(td) / "clip.wav"
            _write_wav(src)
            with self.assertRaises(voiceprint.Unavailable) as caught:
                voiceprint.embed(src)
        self.assertIn("service.diarize --download", reason or "")
        self.assertIn("service.diarize --download", str(caught.exception))

    def test_info_states_identity_not_quality(self) -> None:
        info = voiceprint.info()
        self.assertEqual(info["version"], voiceprint.VERSION)
        self.assertIn("identity", info["measures"])
        self.assertIn("not perceptual quality", info["measures"])
        # available/reason are the two halves of one fact and must agree.
        self.assertEqual(info["available"], info["reason"] is None)
        self.assertEqual(info["model"], str(diarize.embedding_path()))


# ── 2a. the maths, which has no dependencies at all ─────────────────────────
class SimilarityTests(_VoiceprintCase):
    def test_identical_opposite_orthogonal(self) -> None:
        a, b = _unit(1, 0), _unit(0, 1)
        self.assertAlmostEqual(voiceprint.similarity(a, a), 1.0, places=6)
        self.assertAlmostEqual(voiceprint.similarity(a, -a), -1.0, places=6)
        self.assertAlmostEqual(voiceprint.similarity(a, b), 0.0, places=6)

    def test_clamped_into_its_own_range(self) -> None:
        big = _unit(1, 1) * 1e8
        self.assertLessEqual(voiceprint.similarity(big, big), 1.0)
        self.assertGreaterEqual(voiceprint.similarity(big, -big), -1.0)

    def test_zero_vector_raises_instead_of_scoring_zero(self) -> None:
        with self.assertRaises(ValueError):
            voiceprint.similarity(np.zeros(DIM), _unit(1, 0))

    def test_size_mismatch_names_the_model_problem(self) -> None:
        with self.assertRaises(ValueError) as caught:
            voiceprint.similarity(np.zeros(4) + 1, np.zeros(5) + 1)
        self.assertIn("same model", str(caught.exception))


class CentroidTests(_VoiceprintCase):
    def test_magnitude_cannot_pull_the_centre(self) -> None:
        a, b = _unit(1, 0), _unit(0, 1)
        loud = voiceprint.centroid([a * 500.0, b])
        even = voiceprint.centroid([a, b])
        self.assertAlmostEqual(voiceprint.similarity(loud, even), 1.0, places=5)
        self.assertAlmostEqual(float(np.linalg.norm(even)), 1.0, places=5)

    def test_no_common_direction_raises(self) -> None:
        with self.assertRaises(ValueError):
            voiceprint.centroid([_unit(1, 0), _unit(-1, 0)])
        with self.assertRaises(ValueError):
            voiceprint.centroid([])


# ── 2b. audio in ────────────────────────────────────────────────────────────
class ReadSamplesTests(_VoiceprintCase):
    def test_pipeline_wav_is_resampled_to_the_model_rate(self) -> None:
        with TemporaryDirectory() as td:
            src = Path(td) / "s.wav"
            _write_wav(src, frames=24000, rate=24000)      # 1.0s at 24 kHz
            got = voiceprint.read_samples(src)
        self.assertEqual(got.dtype, np.float32)
        self.assertAlmostEqual(got.size / voiceprint.TARGET_RATE, 1.0, places=2)
        self.assertLessEqual(float(np.max(np.abs(got))), 1.0)

    def test_stereo_is_averaged_and_8_and_32_bit_are_read(self) -> None:
        with TemporaryDirectory() as td:
            for width, channels in ((2, 2), (1, 1), (4, 1)):
                src = Path(td) / f"w{width}c{channels}.wav"
                _write_wav(src, frames=16000, rate=16000, width=width,
                           channels=channels)
                got = voiceprint.read_samples(src)
                self.assertEqual(got.size, 16000, f"width={width}")

    def test_unreadable_shapes_are_refused_by_name(self) -> None:
        with TemporaryDirectory() as td:
            empty = Path(td) / "empty.wav"
            _write_wav(empty, frames=0)
            with self.assertRaises(ValueError) as caught:
                voiceprint.read_samples(empty)
            self.assertIn("no audio frames", str(caught.exception))

            odd = Path(td) / "odd.wav"          # 24-bit: real, and unsupported
            with wave.open(str(odd), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(3)
                w.setframerate(16000)
                w.writeframes(b"\x00\x01\x02" * 16000)
            with self.assertRaises(ValueError) as caught:
                voiceprint.read_samples(odd)
            self.assertIn("24-bit", str(caught.exception))


class EmbedPlumbingTests(_VoiceprintCase):
    def _with_model(self, td: str):
        model = Path(td) / diarize.EMBEDDING_FILE
        model.parent.mkdir(parents=True, exist_ok=True)
        model.write_bytes(b"onnx")
        return mock.patch.object(diarize, "models_dir", lambda: Path(td))

    def test_extractor_gets_the_diarize_model_and_16k_float32_audio(self) -> None:
        built: list = []
        seen: list = []

        def compute(stream):
            seen.append((stream.rate, stream.waveform.dtype, stream.finished))
            return [1.0] + [0.0] * (DIM - 1)

        with TemporaryDirectory() as td, self._with_model(td), \
             mock.patch.dict(sys.modules,
                             {"sherpa_onnx": _fake_sherpa(compute, built)}):
            src = Path(td) / "clip.wav"
            _write_wav(src, frames=24000)
            first = voiceprint.embed(src)
            second = voiceprint.embed(src)        # same load, second call
        self.assertEqual(len(built), 1)           # loaded ONCE and cached
        self.assertEqual(built[0].model, str(Path(td) / diarize.EMBEDDING_FILE))
        self.assertEqual(seen[0][0], voiceprint.TARGET_RATE)
        self.assertEqual(seen[0][1], np.float32)
        self.assertTrue(seen[0][2])               # input_finished() was called
        self.assertAlmostEqual(voiceprint.similarity(first, second), 1.0, places=6)

    def test_too_short_and_unusable_vectors_are_named(self) -> None:
        with TemporaryDirectory() as td, self._with_model(td), \
             mock.patch.dict(sys.modules, {"sherpa_onnx": _fake_sherpa()}):
            tiny = Path(td) / "tiny.wav"
            _write_wav(tiny, frames=240)          # 10 ms
            with self.assertRaises(ValueError) as caught:
                voiceprint.embed(tiny)
            self.assertIn("embedding needs", str(caught.exception))

        nan = _fake_sherpa(lambda stream: [float("nan")] * DIM)
        with TemporaryDirectory() as td, self._with_model(td), \
             mock.patch.dict(sys.modules, {"sherpa_onnx": nan}):
            src = Path(td) / "clip.wav"
            _write_wav(src, frames=24000)
            with self.assertRaises(ValueError) as caught:
                voiceprint.embed(src)
            self.assertIn("no usable vector", str(caught.exception))


# ── 3. judgement: which segments are this speaker ───────────────────────────
def _labels(spec: list[tuple[str, str]]) -> list[dict]:
    """[(emotion, tag)] -> label rows shaped like label_and_stem's `usable`."""
    return [{"i": i, "emotion": emo, "wav": f"seg_{i:03d}.wav", "tag": tag}
            for i, (emo, tag) in enumerate(spec)]


_EMBED_TAGS: list[str] = []
_SPEAKER = _unit(1.0, 0.05)
_NEARBY = _unit(1.0, 0.35)           # same person, unusual delivery
_FOREIGN = _unit(-0.6, 1.0)          # somebody else in the room
# Four bystanders pointing in directions that CANCEL, so the speaker's centroid
# stays where it belongs and the drop budget is what limits the damage.
_CROWD = {"themA": _unit(0, 1), "themB": _unit(0, -1),
          "themC": _unit(0, 0, 1), "themD": _unit(0, 0, -1)}


def _vector(tag: str, i: int) -> "np.ndarray":
    if tag == "me":
        # Jittered: one real speaker's clips are near each other, not identical,
        # and a zero-spread fixture would make the MAD rule untestable.
        return _unit(1.0, 0.04 + 0.015 * (i % 4))
    if tag == "odd":
        return _NEARBY
    if tag == "them":
        return _FOREIGN
    return _CROWD[tag]


def _embedder(fail: set[str] | None = None):
    """Embed by TAG, from the label's wav name — synthetic voices, no audio."""
    def embed(path):
        i = int(Path(path).stem.split("_")[1])
        tag = _EMBED_TAGS[i]
        if fail and tag in fail:
            raise ValueError(f"cannot embed {tag}")
        return _vector(tag, i)
    return embed


def _scan(spec: list[tuple[str, str]], fail: set[str] | None = None):
    global _EMBED_TAGS
    labels = _labels(spec)
    _EMBED_TAGS = [t for _, t in spec]
    return ingest.measure_segments(labels, embed=_embedder(fail))


class SegmentJudgementTests(unittest.TestCase):
    def test_unavailable_embedder_reports_and_changes_nothing(self) -> None:
        with mock.patch.object(ingest.voiceprint, "unavailable_reason",
                               lambda: "sherpa-onnx is not installed."):
            scan = ingest.measure_segments(_labels([(BASELINE, "me")] * 4))
        self.assertFalse(scan.payload["available"])
        self.assertIn("sherpa-onnx", scan.payload["reason"])
        self.assertIsNone(scan.payload["reference_similarity"])
        self.assertEqual(scan.payload["segments_measured"], 0)
        self.assertEqual(scan.dropped, set())
        self.assertIsNone(scan.centre)
        # The caveat rides even on the payload that measured nothing.
        self.assertIn("identity", scan.payload["measures"])

    def test_bystander_voice_is_dropped_and_explained(self) -> None:
        scan = _scan([(BASELINE, "me")] * 5 + [(BASELINE, "them")])
        self.assertTrue(scan.payload["available"])
        self.assertGreater(scan.payload["reference_similarity"], 0.9)
        self.assertEqual(scan.dropped, {5})
        self.assertEqual(scan.payload["dropped"], 1)
        out = {o["i"]: o for o in scan.payload["per_segment_outliers"]}
        self.assertEqual(out[5]["action"], "dropped")
        self.assertIn("same speaker", out[5]["why"])
        self.assertLess(out[5]["similarity"], ingest.FOREIGN_SIMILARITY)

    def test_merely_unusual_segment_is_flagged_never_removed(self) -> None:
        scan = _scan([(BASELINE, "me")] * 6 + [(BASELINE, "odd")])
        self.assertEqual(scan.dropped, set())
        out = {o["i"]: o for o in scan.payload["per_segment_outliers"]}
        self.assertEqual(out[6]["action"], "flagged")     # reported, still used
        self.assertIn("still used", out[6]["why"])
        self.assertEqual(scan.payload["flagged"], 1)

    def test_last_audio_for_an_emotion_is_kept_even_when_foreign(self) -> None:
        scan = _scan([(BASELINE, "me")] * 5 + [("happy", "them")])
        self.assertEqual(scan.dropped, set())            # the only happy audio
        out = {o["i"]: o for o in scan.payload["per_segment_outliers"]}
        self.assertEqual(out[5]["action"], "flagged")
        self.assertIn("only remaining audio", out[5]["why"])

    def test_mostly_foreign_is_treated_as_a_broken_measurement(self) -> None:
        scan = _scan([(BASELINE, "me")] * 5 +
                     [(BASELINE, t) for t in ("themA", "themB", "themC", "themD")])
        # A recording of one person is never mostly somebody else: the drop is
        # capped and the surplus reported instead of stripping the recording.
        self.assertLessEqual(len(scan.dropped),
                             int(9 * ingest.MAX_DROP_FRACTION))
        self.assertTrue(scan.dropped)
        kept = [o for o in scan.payload["per_segment_outliers"]
                if o["action"] == "flagged"]
        self.assertTrue(any("not trusted" in (o["why"] or "") for o in kept))

    def test_unembeddable_segments_are_listed_not_hidden(self) -> None:
        scan = _scan([(BASELINE, "me")] * 4 + [(BASELINE, "odd")],
                     fail={"odd"})
        self.assertEqual(scan.payload["segments_measured"], 4)
        self.assertEqual([f["i"] for f in scan.payload["segments_failed"]], [4])
        self.assertIn("cannot embed", scan.payload["segments_failed"][0]["error"])

    def test_too_few_measurable_segments_says_so(self) -> None:
        scan = _scan([(BASELINE, "me"), (BASELINE, "odd")], fail={"me", "odd"})
        self.assertFalse(scan.payload["available"])
        self.assertIn("too few", scan.payload["reason"])
        self.assertEqual(scan.dropped, set())

    def test_stem_scores_are_per_stem_and_failures_are_named(self) -> None:
        scan = _scan([(BASELINE, "me")] * 4)
        stems = {BASELINE: Path("stem_baseline.wav"), "happy": Path("nope.wav")}

        def embed(path):
            if "baseline" not in str(path):
                raise ValueError("no such stem")
            return _SPEAKER
        ingest.score_stems(scan.payload, scan.centre, stems, embed=embed)
        self.assertAlmostEqual(scan.payload["stems"][BASELINE]["identity"], 1.0,
                               places=2)
        self.assertIsNone(scan.payload["stems"]["happy"]["identity"])
        self.assertIn("no such stem", scan.payload["stems"]["happy"]["reason"])


# ── the pipeline publishes it ───────────────────────────────────────────────
def _pipeline_wav(path: Path, frames: int = 24000) -> None:
    _write_wav(path, frames=frames)


class PipelinePayloadTests(unittest.TestCase):
    """`label_and_stem` end to end, with ffmpeg and the classifier mocked (the
    convention in test_ingest_pipeline)."""

    def _work(self, td: str, n: int) -> Path:
        wd = Path(td)
        _pipeline_wav(wd / "clean.wav")
        (wd / "segments.json").write_text(json.dumps(
            [{"speaker": "speaker_0", "start": float(i), "end": float(i) + 1.0,
              "text": f"line {i}"} for i in range(n)]), "utf-8")
        return wd

    def _run(self, wd: Path, partials: list[dict]):
        def label(paths, spend=None):
            return [{"emotion": BASELINE, "confidence": 0.9, "cue": "c",
                     "model": "flash"} for _ in paths]

        with mock.patch.object(ingest, "to_wav",
                               side_effect=lambda src, dst, a=None, b=None:
                               _pipeline_wav(Path(dst), 24000)), \
             mock.patch.object(ingest, "label_emotions", side_effect=label):
            return ingest.label_and_stem(wd, "speaker_0", mode="cloud",
                                         partial=partials.append)

    def test_degraded_run_publishes_a_named_reason_and_no_numbers(self) -> None:
        # The degrade path: no embedder, so the run must name WHY and publish
        # no similarity numbers at all.
        #
        # This used to patch nothing and rely on the box itself lacking the
        # model. That made it pass by accident on a bare machine and FAIL the
        # moment the models were installed here — and, worse, it meant the
        # degrade path went untested on exactly the developer boxes that can
        # run the real pipeline. The absence is stated now, not borrowed from
        # the environment, so this asserts the same thing everywhere.
        partials: list[dict] = []
        with mock.patch.object(voiceprint, "unavailable_reason",
                               return_value=_ABSENT_REASON), \
             TemporaryDirectory() as td:
            res = self._run(self._work(td, 5), partials)
        fid = res["fidelity"]
        self.assertFalse(fid["available"])
        self.assertTrue(fid["reason"])
        self.assertIsNone(fid["reference_similarity"])
        self.assertEqual(fid["stems"], {})
        self.assertEqual(len(res["stems"]), 1)
        for stem in res["stems"]:
            self.assertNotIn("identity", stem)       # absent, not zero
        for seg in res["segments"]:
            self.assertIsNone(seg["outlier"])
        self.assertTrue(any("fidelity" in p for p in partials))

    def test_measured_run_drops_the_bystander_and_scores_the_stems(self) -> None:
        partials: list[dict] = []
        # Segment 4 is somebody else; every stem embeds as the speaker.
        def embed(path):
            name = Path(path).name
            if name == "seg_004.wav":
                return _FOREIGN
            return _SPEAKER if name.startswith("seg_") else _NEARBY

        with TemporaryDirectory() as td, \
             mock.patch.object(ingest.voiceprint, "unavailable_reason",
                               lambda: None), \
             mock.patch.object(ingest.voiceprint, "embed", embed):
            res = self._run(self._work(td, 6), partials)

        fid = res["fidelity"]
        self.assertTrue(fid["available"])
        self.assertEqual(fid["dropped"], 1)
        base = res["stems"][0]
        self.assertEqual(base["emotion"], BASELINE)
        self.assertEqual(base["segments"], 5)        # the bystander is not in it
        self.assertIn("identity", base)              # stem scored
        actions = {s["outlier"] for s in res["segments"] if s["outlier"]}
        self.assertEqual(actions, {"dropped"})
        published = [p["fidelity"] for p in partials if "fidelity" in p]
        self.assertTrue(published and published[-1]["available"])


# ── closing the loop at commit ──────────────────────────────────────────────
class CalibrationTests(unittest.TestCase):
    def test_no_engine_no_synthesizer_is_a_named_skip(self) -> None:
        with TemporaryDirectory() as td:
            ref = Path(td) / "stem.wav"
            _write_wav(ref)
            with mock.patch.object(ingest.voiceprint, "unavailable_reason",
                                   lambda: None), \
                 mock.patch.dict(sys.modules, {"service.app": None}):
                identity, reason = ingest.calibrate_clone(
                    "ada-baseline-abc", ref, Path(td), embed=lambda p: _SPEAKER)
        self.assertIsNone(identity)
        self.assertIn("no synthesis engine", reason)

    def test_unavailable_embedder_skips_before_synthesizing(self) -> None:
        calls: list = []
        with TemporaryDirectory() as td, \
             mock.patch.object(ingest.voiceprint, "unavailable_reason",
                               lambda: "the model is not downloaded."):
            identity, reason = ingest.calibrate_clone(
                "v", Path(td) / "stem.wav", Path(td),
                lambda vid, text: calls.append(vid) or b"")
        self.assertIsNone(identity)
        self.assertIn("not downloaded", reason)
        self.assertEqual(calls, [])          # no synthesis was paid for

    def test_synthesis_failure_is_reported_never_raised(self) -> None:
        def boom(vid, text):
            raise RuntimeError("engine is draining")

        with TemporaryDirectory() as td:
            identity, reason = ingest.calibrate_clone(
                "v", Path(td) / "stem.wav", Path(td), boom,
                embed=lambda p: _SPEAKER)
        self.assertIsNone(identity)
        self.assertIn("engine is draining", reason)

    def test_scores_the_synthesized_line_against_the_stem(self) -> None:
        from service.tests.fake_engine import make_wav

        seen: list = []

        def synth(voice_id, text):
            seen.append((voice_id, text))
            return make_wav(1000, frames=24000)

        with TemporaryDirectory() as td:
            ref = Path(td) / "stem.wav"
            _write_wav(ref)
            identity, reason = ingest.calibrate_clone(
                "ada-baseline-abc", ref, Path(td), synth,
                embed=lambda p: _SPEAKER if "calib" in Path(p).name else _NEARBY)
            self.assertTrue((Path(td) / "calib_ada-baseline-abc.wav").is_file())
        self.assertIsNone(reason)
        self.assertAlmostEqual(identity, round(
            voiceprint.similarity(_SPEAKER, _NEARBY), 3), places=3)
        self.assertEqual(seen[0][1], ingest.CALIBRATION_TEXT)   # ONE fixed line


class CommitLoopTests(unittest.TestCase):
    def _stems(self, td: str, emotions) -> Path:
        wd = Path(td)
        for e in emotions:
            _write_wav(wd / f"stem_{e}.wav", frames=24000 * 6)
        return wd

    def _commit(self, wd: Path, root: Path, **kw):
        from service.tests.test_ingest_lifecycle import _FakeExportPopen
        from service import voices as vc
        _FakeExportPopen.spawned = 0
        with mock.patch.object(ingest, "VOICES_DIR", root), \
             mock.patch.object(vc, "VOICES_DIR", root), \
             mock.patch.object(vc, "META_PATH", root / "_meta.json"), \
             mock.patch.object(ingest.subprocess, "Popen", _FakeExportPopen):
            return ingest.commit(wd, "Ada", ["happy"], None, consent="mine",
                                 clip_sha256="h", **kw)

    def test_identity_reaches_the_registry_row_and_the_caller(self) -> None:
        from service.tests.fake_engine import make_wav

        with TemporaryDirectory() as td, TemporaryDirectory() as vtd:
            wd = self._stems(td, ["happy"])
            root = Path(vtd)
            with mock.patch.object(ingest.voiceprint, "unavailable_reason",
                                   lambda: None), \
                 mock.patch.object(ingest.voiceprint, "embed",
                                   lambda p: _SPEAKER if "calib" in Path(p).name
                                   else _NEARBY):
                created = self._commit(
                    wd, root, synthesize=lambda vid, text: make_wav(7, frames=24000))
            meta = json.loads((root / "_meta.json").read_text("utf-8"))

        expected = round(voiceprint.similarity(_SPEAKER, _NEARBY), 3)
        self.assertEqual(created[0]["identity"], expected)
        self.assertNotIn("identity_reason", created[0])
        row = next(iter(meta["voices"].values()))
        # The schema belongs to voices.py (design C1); what is asserted here is
        # that the measured number arrives on the row under `identity`.
        self.assertEqual(row["fidelity"]["identity"], expected)
        self.assertEqual(row["consent"]["statement"], "mine")   # unchanged

    def test_unmeasurable_box_clones_normally_and_says_why(self) -> None:
        synth_calls: list = []
        with TemporaryDirectory() as td, TemporaryDirectory() as vtd:
            wd = self._stems(td, ["happy"])
            root = Path(vtd)
            with mock.patch.object(ingest.voiceprint, "unavailable_reason",
                                   lambda: "sherpa-onnx is not installed."):
                created = self._commit(
                    wd, root,
                    synthesize=lambda vid, text: synth_calls.append(vid) or b"")
            meta = json.loads((root / "_meta.json").read_text("utf-8"))

        self.assertEqual(len(created), 1)                       # clone shipped
        self.assertNotIn("identity", created[0])                # absent, not 0
        self.assertIn("sherpa-onnx", created[0]["identity_reason"])
        self.assertNotIn("fidelity", next(iter(meta["voices"].values())))
        self.assertEqual(synth_calls, [])       # no CPU spent on an unscorable line

    def test_a_failing_measurement_never_fails_the_clone(self) -> None:
        def boom(path):
            raise RuntimeError("onnxruntime exploded")

        with TemporaryDirectory() as td, TemporaryDirectory() as vtd:
            wd = self._stems(td, ["happy"])
            root = Path(vtd)
            with mock.patch.object(ingest.voiceprint, "unavailable_reason",
                                   lambda: None), \
                 mock.patch.object(ingest.voiceprint, "embed", boom):
                created = self._commit(
                    wd, root, synthesize=lambda vid, text: b"not-a-wav")
        self.assertEqual([c["emotion"] for c in created], ["happy"])
        self.assertIn("not scored", created[0]["identity_reason"])


if __name__ == "__main__":
    unittest.main()
