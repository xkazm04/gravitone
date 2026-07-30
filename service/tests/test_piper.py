"""The second mouth: Piper voices, and how a Czech agent finds one.

Two things are tested. The first is discovery — a voice is a pair of files on
disk, so "which voices exist" is filesystem logic and worth pinning (a half-
finished download must not be offered as a voice). The second is the resolution
rule in service/convai.py, which is the actual fix: a Czech agent must not fall
through to an English voice and read Czech words with English phonemes.

Piper itself is stubbed. Real synthesis is opt-in:

    GRAVITONE_PIPER_E2E=1 python -m unittest service.tests.test_piper
"""
from __future__ import annotations

import dataclasses
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

from service.tests import fake_engine  # installs shims — must precede app import

from service import convai, dialog, piper  # noqa: E402

E2E = os.environ.get("GRAVITONE_PIPER_E2E") == "1"


class _Chunk:
    def __init__(self, pcm: bytes, rate: int):
        self.audio_int16_bytes, self.sample_rate = pcm, rate


class _FakeVoice:
    loaded: list[str] = []

    def __init__(self, path: str):
        type(self).loaded.append(path)

    def synthesize(self, text: str):
        # 22.05 kHz, like the real *-medium voices — the rate the caller must
        # resample from rather than assume.
        yield _Chunk(b"\x01\x02" * (len(text) * 100), 22050)


def _install_fake(monkey: dict) -> None:
    module = types.ModuleType("piper")
    module.PiperVoice = types.SimpleNamespace(load=lambda p: _FakeVoice(p))
    monkey["piper"] = sys.modules.get("piper")
    sys.modules["piper"] = module


class _PiperCase(unittest.TestCase):
    def setUp(self) -> None:
        self._monkey: dict = {}
        _install_fake(self._monkey)
        _FakeVoice.loaded.clear()
        self._tmp = tempfile.TemporaryDirectory()
        self._orig = piper.SETTINGS
        piper.SETTINGS = dataclasses.replace(piper.SETTINGS,
                                             piper_voices_dir=self._tmp.name)
        piper._CACHE.clear()

    def tearDown(self) -> None:
        for name, prev in self._monkey.items():
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev
        piper.SETTINGS = self._orig
        piper._CACHE.clear()
        self._tmp.cleanup()

    def add_voice(self, name: str, *, with_config: bool = True) -> None:
        d = Path(self._tmp.name)
        (d / f"{name}.onnx").write_bytes(b"onnx")
        if with_config:
            (d / f"{name}.onnx.json").write_text("{}", "utf-8")


class DiscoveryTests(_PiperCase):
    def test_no_voices_is_a_valid_installation(self) -> None:
        self.assertEqual(piper.list_voices(), [])
        self.assertFalse(piper.has_voice("anything"))
        self.assertIsNone(piper.voice_for_language("cs"))

    def test_a_voice_is_found_and_its_language_derived(self) -> None:
        self.add_voice("cs_CZ-jirka-medium")
        found = piper.list_voices()
        self.assertEqual([v.voice_id for v in found], ["cs_CZ-jirka-medium"])
        self.assertEqual(found[0].language, "cs")
        self.assertTrue(piper.has_voice("cs_CZ-jirka-medium"))

    def test_a_half_finished_download_is_not_offered(self) -> None:
        """Without the .onnx.json Piper cannot load it, so it is not a voice."""
        self.add_voice("en_US-lessac-medium", with_config=False)
        self.assertEqual(piper.list_voices(), [])

    def test_a_language_finds_whichever_voice_speaks_it(self) -> None:
        self.add_voice("cs_CZ-jirka-medium")
        self.add_voice("en_US-lessac-medium")
        self.assertEqual(piper.voice_for_language("cs"), "cs_CZ-jirka-medium")
        self.assertEqual(piper.voice_for_language("en"), "en_US-lessac-medium")
        self.assertEqual(piper.voice_for_language("cs-CZ"), "cs_CZ-jirka-medium")
        self.assertIsNone(piper.voice_for_language("de"))
        self.assertIsNone(piper.voice_for_language(""))

    def test_info_reports_what_this_replica_can_speak(self) -> None:
        self.add_voice("cs_CZ-jirka-medium")
        described = piper.info()
        self.assertEqual(described["voices"], ["cs_CZ-jirka-medium"])
        self.assertEqual(described["languages"], ["cs"])


class SynthesisTests(_PiperCase):
    def test_synthesis_returns_pcm_at_the_voices_own_rate(self) -> None:
        self.add_voice("cs_CZ-jirka-medium")
        pcm, rate = piper.synthesize_pcm("cs_CZ-jirka-medium", "Dobrý den.")
        self.assertEqual(rate, 22050)   # NOT resampled here — the caller decides
        self.assertTrue(pcm)

    def test_a_voice_is_loaded_once_and_kept_hot(self) -> None:
        self.add_voice("cs_CZ-jirka-medium")
        piper.synthesize_pcm("cs_CZ-jirka-medium", "jedna")
        piper.synthesize_pcm("cs_CZ-jirka-medium", "dva")
        self.assertEqual(len(_FakeVoice.loaded), 1)

    def test_empty_text_synthesizes_nothing(self) -> None:
        self.add_voice("cs_CZ-jirka-medium")
        pcm, _ = piper.synthesize_pcm("cs_CZ-jirka-medium", "   ")
        self.assertEqual(pcm, b"")
        self.assertEqual(_FakeVoice.loaded, [])   # never even loaded

    def test_an_unknown_voice_says_how_to_download_it(self) -> None:
        with self.assertRaises(piper.PiperUnavailable) as caught:
            piper.synthesize_pcm("de_DE-thorsten-medium", "Hallo")
        message = str(caught.exception)
        self.assertIn("download_voices", message)
        self.assertIn("de_DE-thorsten-medium", message)

    def test_a_wav_wrapper_carries_the_right_rate(self) -> None:
        import io
        import wave

        self.add_voice("cs_CZ-jirka-medium")
        wav, rate = piper.synthesize_wav("cs_CZ-jirka-medium", "Dobrý den.")
        with wave.open(io.BytesIO(wav), "rb") as w:
            self.assertEqual(w.getframerate(), rate)
            self.assertEqual(w.getnchannels(), 1)
            self.assertEqual(w.getsampwidth(), 2)

    def test_a_missing_library_says_what_to_install(self) -> None:
        self.add_voice("cs_CZ-jirka-medium")
        sys.modules["piper"] = None  # makes `import piper` raise
        with self.assertRaises(piper.PiperUnavailable) as caught:
            piper.synthesize_pcm("cs_CZ-jirka-medium", "Dobrý den.")
        self.assertIn("pip install", str(caught.exception))


class VoiceResolutionTests(_PiperCase):
    """The rule that decides which engine speaks for an agent."""

    @staticmethod
    def agent(**kwargs) -> dialog.Agent:
        base = {"agent_id": "a", "name": "A", "prompt": "p"}
        return dialog.Agent(**(base | kwargs))

    def test_an_english_agent_uses_pocket_tts(self) -> None:
        voice, is_piper = convai._resolve_voice(self.agent(language="en"))
        self.assertFalse(is_piper)
        self.assertEqual(voice, convai.SETTINGS.default_voice)

    def test_a_czech_agent_finds_a_czech_voice_from_language_alone(self) -> None:
        """The actual fix: no voice_id needed, just `language: "cs"`."""
        self.add_voice("cs_CZ-jirka-medium")
        voice, is_piper = convai._resolve_voice(self.agent(language="cs"))
        self.assertTrue(is_piper)
        self.assertEqual(voice, "cs_CZ-jirka-medium")

    def test_a_czech_agent_with_no_czech_voice_refuses(self) -> None:
        """Rather than reading Czech words with English phonemes.

        A conversation that cannot be spoken should fail loudly at connect, not
        produce audio nobody can use.
        """
        with self.assertRaises(convai.VoiceUnavailable) as caught:
            convai._resolve_voice(self.agent(language="cs"))
        message = str(caught.exception)
        self.assertIn("download_voices", message)
        self.assertIn("cs", message)

    def test_an_explicit_piper_voice_wins(self) -> None:
        self.add_voice("cs_CZ-jirka-medium")
        voice, is_piper = convai._resolve_voice(
            self.agent(language="en", voice_id="cs_CZ-jirka-medium"))
        self.assertTrue(is_piper)
        self.assertEqual(voice, "cs_CZ-jirka-medium")

    def test_an_explicit_pocket_voice_stays_on_pocket_tts(self) -> None:
        voice, is_piper = convai._resolve_voice(self.agent(voice_id="vera"))
        self.assertFalse(is_piper)
        self.assertEqual(voice, "vera")

    def test_french_stays_on_pocket_tts_because_it_can_speak_it(self) -> None:
        voice, is_piper = convai._resolve_voice(self.agent(language="fr"))
        self.assertFalse(is_piper)

    def test_a_regional_tag_is_understood(self) -> None:
        self.add_voice("cs_CZ-jirka-medium")
        _, is_piper = convai._resolve_voice(self.agent(language="cs-CZ"))
        self.assertTrue(is_piper)

    def test_the_shipped_czech_agent_reports_itself_unspeakable_without_a_voice(self) -> None:
        described = convai._describe_agent(dialog.BUILTIN_AGENTS["local-interviewer-cs"])
        self.assertFalse(described["speakable"])
        self.assertIn("download_voices", described["problem"])

    def test_the_shipped_czech_agent_works_once_a_voice_is_installed(self) -> None:
        self.add_voice("cs_CZ-jirka-medium")
        described = convai._describe_agent(dialog.BUILTIN_AGENTS["local-interviewer-cs"])
        self.assertTrue(described["speakable"])
        self.assertEqual(described["tts"], "piper")
        self.assertEqual(described["voice_id"], "cs_CZ-jirka-medium")


@unittest.skipUnless(E2E, "set GRAVITONE_PIPER_E2E=1 (needs downloaded voices)")
class RealPiperTests(unittest.TestCase):
    def test_it_actually_speaks_czech(self) -> None:
        if not piper.voice_for_language("cs"):
            self.skipTest("no Czech voice in " + str(piper.voices_dir()))
        voice = piper.voice_for_language("cs")
        pcm, rate = piper.synthesize_pcm(
            voice, "Dobrý den, povězte mi něco o své praxi.")
        seconds = len(pcm) / (rate * 2)
        print(f"\n  {voice}: {seconds:.2f}s of Czech at {rate} Hz")
        # A sentence that long is at least a second of speech; anything less
        # means the phonemizer dropped the text on the floor.
        self.assertGreater(seconds, 1.0)


if __name__ == "__main__":
    unittest.main()
