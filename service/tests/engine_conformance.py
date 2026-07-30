"""The conformance kit: one suite every speech adapter has to pass.

This is the point of the engine plane. Capabilities are a claim, and a claim
nobody checks is how an adapter ends up advertising a language it mangles. So
the same seven behaviours are driven against BOTH shipped adapters through
identical code, and adding a third engine means writing a fixture class here,
not a new test file:

  1. the declaration is well formed (the boot check, run against the adapter)
  2. the sample rate is HONEST -- what comes back is what the container says,
     and if the adapter declared a native rate it is that rate
  3. empty text is silence, not an error
  4. an unknown voice says how to INSTALL the missing one
  5. concurrent synthesis stays inside the bound the adapter declared
  6. the WAV container is really a WAV: mono, 16-bit, at the stated rate
  7. capability claims match behaviour -- every language an adapter claims
     resolves, through the plane's own rule, to a voice in THAT engine which
     really produces audio

No models are loaded. Piper is stubbed exactly the way ``test_piper`` stubs it
(a voice is two files on disk; synthesis is a fake ONNX session), and Pocket TTS
runs against ``fake_engine.FakeEngine`` -- the same worker-pool stand-in every
HTTP test uses. Both fakes already record what they were asked to do
concurrently, which is what makes check 5 an observation rather than a promise.

    PYTHONIOENCODING=utf-8 python -m unittest service.tests.engine_conformance
"""
from __future__ import annotations

import dataclasses
import io
import json
import sys
import tempfile
import threading
import time
import types
import unittest
import wave
from pathlib import Path

from service.tests import fake_engine  # installs shims — must precede app import

from service import engines, piper  # noqa: E402

CS_VOICE = "cs_CZ-jirka-medium"
PIPER_RATE = 22050


# ---------------------------------------------------------------------------
# The suite. A plain mixin, NOT a TestCase: a base TestCase would run its own
# checks with no adapter bound and report phantom failures.
# ---------------------------------------------------------------------------
class ConformanceSuite:
    """What every adapter must do. Subclasses bind the fixture, nothing else.

    A fixture supplies: ``self.adapter``, ``self.voice`` (an installed voice),
    ``self.unknown_voice``, ``self.install_marker`` (the string the unknown-voice
    refusal must contain), and ``observed_concurrency()``.
    """

    #: Set by the fixture in setUp.
    adapter: engines.SpeechEngine
    voice: str
    unknown_voice: str
    install_marker: str

    SENTENCE = "This is a sentence long enough to be worth measuring."

    def observed_concurrency(self) -> int:
        raise NotImplementedError

    # -- 1. the declaration ---------------------------------------------------
    def test_the_declaration_is_well_formed(self) -> None:
        checked, problems = engines.check_declaration(self.adapter)
        self.assertEqual(problems, [])
        self.assertGreater(checked, 0)

    # -- 2. honest sample rate ------------------------------------------------
    def test_the_sample_rate_is_honest(self) -> None:
        """The rate an adapter RETURNS is the rate its audio really is.

        And a DECLARED native rate must equal the observed one -- an adapter
        that says 22.05 kHz and hands back 16 kHz is the exact drift this plane
        exists to catch. An adapter that declares nothing is not failed for it:
        absent is a legitimate answer (Pocket TTS cannot know its model's rate
        without loading the model), and it is reported as absent.
        """
        pcm, rate = self.adapter.synthesize_pcm(self.voice, self.SENTENCE)
        self.assertTrue(pcm, "a real sentence must produce audio")
        self.assertGreater(rate, 0)
        self.assertEqual(len(pcm) % 2, 0, "PCM16 comes in whole samples")

        declared = self.adapter.capabilities().native_rate
        if declared is not None:
            self.assertEqual(declared, rate)

        wav, wav_rate = self.adapter.synthesize_wav(self.voice, self.SENTENCE)
        self.assertEqual(wav_rate, rate)
        with wave.open(io.BytesIO(wav), "rb") as w:
            self.assertEqual(w.getframerate(), rate)

    def test_the_observed_rate_is_published_as_proven(self) -> None:
        """Having synthesized, the plane may report a rate it has SEEN."""
        self.adapter.synthesize_pcm(self.voice, self.SENTENCE)
        engine_id = self.adapter.capabilities().engine_id
        self.assertGreater(engines.observed_rate(engine_id) or 0, 0)

    # -- 3. empty text --------------------------------------------------------
    def test_empty_text_is_silence_not_an_error(self) -> None:
        """Nothing to say is a normal thing for a synthesizer to be asked.

        A reply whose last sentence is a pure direction ("[end_call]") renders
        to an empty string, and an adapter that raised on it would turn a
        finished conversation into a failed turn.
        """
        for text in ("", "   ", "\n\t "):
            with self.subTest(text=repr(text)):
                pcm, rate = self.adapter.synthesize_pcm(self.voice, text)
                self.assertEqual(pcm, b"")
                self.assertGreater(rate, 0)
                wav, _ = self.adapter.synthesize_wav(self.voice, text)
                with wave.open(io.BytesIO(wav), "rb") as w:
                    self.assertEqual(w.getnframes(), 0)

    # -- 4. unknown voice -----------------------------------------------------
    def test_an_unknown_voice_names_the_install_path(self) -> None:
        """The refusal has to be actionable. "voice not found" is not.

        Every engine's answer to "I do not have that voice" must say how to get
        one, because the operator hitting this has a service that will not
        speak and no other place to look.
        """
        with self.assertRaises(RuntimeError) as caught:
            self.adapter.synthesize_pcm(self.unknown_voice, self.SENTENCE)
        message = str(caught.exception)
        self.assertIn(self.unknown_voice, message)
        self.assertIn(self.install_marker, message)

    # -- 5. the concurrency bound --------------------------------------------
    def test_concurrent_synthesis_stays_inside_the_declared_bound(self) -> None:
        """Two engines running unsynchronized would spend the same cores twice.

        The bound is the adapter's own declaration (Piper: one run lock; Pocket
        TTS: the worker pool's parallelism), and it is OBSERVED inside the fake
        engine rather than asserted about the wrapper -- what matters is how
        many syntheses were really in flight, not how many callers were waiting.
        """
        bound = self.adapter.capabilities().concurrency
        errors: list[BaseException] = []

        def one(n: int) -> None:
            try:
                self.adapter.synthesize_pcm(self.voice, f"Sentence {n}.")
            except BaseException as exc:  # noqa: BLE001 - reported below
                errors.append(exc)

        threads = [threading.Thread(target=one, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        self.assertEqual(errors, [])
        self.assertLessEqual(self.observed_concurrency(), bound)
        self.assertGreater(self.observed_concurrency(), 0)

    # -- 6. the container -----------------------------------------------------
    def test_the_wav_container_is_correct(self) -> None:
        wav, rate = self.adapter.synthesize_wav(self.voice, self.SENTENCE)
        with wave.open(io.BytesIO(wav), "rb") as w:
            self.assertEqual(w.getnchannels(), 1)
            self.assertEqual(w.getsampwidth(), 2)
            self.assertEqual(w.getframerate(), rate)
            self.assertGreater(w.getnframes(), 0)

    # -- 7. claims vs behaviour ----------------------------------------------
    def test_every_claimed_language_routes_here_and_speaks(self) -> None:
        """A claimed language must be one the PLANE would actually send here.

        This is the drift check with teeth: it walks the adapter's declared
        languages through ``engines.resolve`` -- the same rule the conversation
        socket uses -- and requires that the answer is this engine, with a voice
        this engine can really synthesize with. An adapter claiming Czech while
        the router would hand Czech to somebody else is a lie the manifest can
        no longer tell.
        """
        caps = self.adapter.capabilities()
        self.assertTrue(caps.languages, "the fixture must install a language")
        for language in caps.languages:
            with self.subTest(language=language):
                engine_id, voice_id = engines.resolve(language)
                self.assertEqual(engine_id, caps.engine_id)
                self.assertIn(voice_id, self.adapter.list_voices())
                pcm, rate = self.adapter.synthesize_pcm(voice_id, self.SENTENCE)
                self.assertTrue(pcm)
                self.assertGreater(rate, 0)

    def test_every_listed_voice_is_a_string_id(self) -> None:
        listed = self.adapter.list_voices()
        self.assertTrue(all(isinstance(v, str) and v for v in listed))
        self.assertIn(self.voice, listed)


# ---------------------------------------------------------------------------
# Fixture: Piper (stubbed ONNX, voices are files on disk)
# ---------------------------------------------------------------------------
class _FakeChunk:
    def __init__(self, pcm: bytes, rate: int) -> None:
        self.audio_int16_bytes, self.sample_rate = pcm, rate


class _FakeVoice:
    """A stubbed Piper voice that RECORDS how many syntheses overlapped."""

    live = 0
    peak = 0
    lock = threading.Lock()

    def __init__(self, path: str) -> None:
        self.path = path

    @classmethod
    def reset(cls) -> None:
        with cls.lock:
            cls.live = cls.peak = 0

    def synthesize(self, text: str):
        cls = type(self)
        with cls.lock:
            cls.live += 1
            cls.peak = max(cls.peak, cls.live)
        try:
            time.sleep(0.02)   # wide enough for an unlocked engine to overlap
            yield _FakeChunk(b"\x01\x02" * (len(text) * 50), PIPER_RATE)
        finally:
            with cls.lock:
                cls.live -= 1


class PiperConformanceTests(ConformanceSuite, unittest.TestCase):
    """Piper: many languages, fixed voices, one run lock, 22.05 kHz declared."""

    install_marker = "download_voices"
    unknown_voice = "de_DE-thorsten-medium"

    def setUp(self) -> None:
        self._prev_module = sys.modules.get("piper")
        module = types.ModuleType("piper")
        module.PiperVoice = types.SimpleNamespace(load=lambda p: _FakeVoice(p))
        sys.modules["piper"] = module
        _FakeVoice.reset()

        self._tmp = tempfile.TemporaryDirectory()
        self._settings = piper.SETTINGS
        piper.SETTINGS = dataclasses.replace(piper.SETTINGS,
                                             piper_voices_dir=self._tmp.name)
        piper._CACHE.clear()
        d = Path(self._tmp.name)
        (d / f"{CS_VOICE}.onnx").write_bytes(b"onnx")
        # The REAL shape piper writes beside a voice: the rate lives here, which
        # is why the adapter can declare a native rate at all.
        (d / f"{CS_VOICE}.onnx.json").write_text(
            json.dumps({"audio": {"sample_rate": PIPER_RATE}}), "utf-8")

        self.adapter = engines.get(engines.PIPER)
        self.voice = CS_VOICE

    def tearDown(self) -> None:
        if self._prev_module is None:
            sys.modules.pop("piper", None)
        else:
            sys.modules["piper"] = self._prev_module
        piper.SETTINGS = self._settings
        piper._CACHE.clear()
        self._tmp.cleanup()

    def observed_concurrency(self) -> int:
        return _FakeVoice.peak

    def test_the_native_rate_is_read_from_the_voice_config(self) -> None:
        """Declared because it was READ, not because 22 050 is a good guess."""
        self.assertEqual(self.adapter.capabilities().native_rate, PIPER_RATE)

    def test_voices_that_disagree_declare_no_native_rate(self) -> None:
        """Two rates on disk means there is no single native rate to claim."""
        d = Path(self._tmp.name)
        (d / "de_DE-other-low.onnx").write_bytes(b"onnx")
        (d / "de_DE-other-low.onnx.json").write_text(
            json.dumps({"audio": {"sample_rate": 16000}}), "utf-8")
        self.assertIsNone(self.adapter.capabilities().native_rate)


# ---------------------------------------------------------------------------
# Fixture: Pocket TTS (the real worker-pool stand-in)
# ---------------------------------------------------------------------------
class PocketConformanceTests(ConformanceSuite, unittest.TestCase):
    """Pocket TTS: English/French, cloning, emotion, the pool's parallelism."""

    install_marker = "/v1/voices"
    unknown_voice = "no-such-voice"

    def setUp(self) -> None:
        self.engine = fake_engine.FakeEngine(workers=2, delay=0.02)
        engines.set_pool_provider(lambda: self.engine)
        self.adapter = engines.get(engines.POCKET)
        # A built-in voice: service/voices.py ships the premade roster, so this
        # id exists with no registry file and no clone.
        self.voice = "alba"

    def tearDown(self) -> None:
        engines.set_pool_provider(None)
        self.engine.close()

    def observed_concurrency(self) -> int:
        return self.engine.max_concurrent

    def test_the_bound_is_the_pools_own_parallelism(self) -> None:
        """Not a number this adapter invented: it asks the pool."""
        self.assertEqual(self.adapter.capabilities().concurrency,
                         self.engine.workers)

    def test_no_pool_says_so_rather_than_pretending(self) -> None:
        engines.set_pool_provider(lambda: None)
        with self.assertRaises(RuntimeError) as caught:
            self.adapter.synthesize_pcm(self.voice, self.SENTENCE)
        self.assertIn("not running", str(caught.exception))


# ---------------------------------------------------------------------------
# Publishing the result
# ---------------------------------------------------------------------------
class ConformancePublicationTests(unittest.TestCase):
    """Passing the suite is a fact /v1/engines is allowed to report.

    Recorded through the module's own seam rather than by editing its state, so
    "behavioural" on the engines surface can only ever mean this suite actually
    ran against that adapter.
    """

    def setUp(self) -> None:
        self._prev = {eid: engines.conformance(eid)
                      for eid in engines.engines()}

    def tearDown(self) -> None:
        for eid, report in self._prev.items():
            if report is None:
                engines._CONFORMANCE.pop(eid, None)
            else:
                engines._CONFORMANCE[eid] = report

    def test_a_behavioural_result_replaces_the_boot_declaration(self) -> None:
        self.assertEqual(engines.conformance(engines.PIPER).level, "declaration")
        engines.record_conformance(engines.PIPER, level="behavioural",
                                   passed=True, checked=9)
        report = engines.conformance(engines.PIPER)
        self.assertEqual(report.level, "behavioural")
        self.assertTrue(report.passed)
        self.assertEqual(report.problems, ())

    def test_a_failure_is_recorded_with_its_reasons(self) -> None:
        engines.record_conformance(engines.POCKET, level="behavioural",
                                   passed=False, checked=9,
                                   problems=("claimed 'de', spoke silence",))
        report = engines.conformance(engines.POCKET)
        self.assertFalse(report.passed)
        self.assertIn("claimed 'de'", report.problems[0])


if __name__ == "__main__":
    unittest.main()
