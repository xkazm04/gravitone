"""The one test that uses no stand-ins: say a sentence, then hear it back.

Everything else about speech-to-text is tested with a recording stub, which
proves the plumbing and proves nothing about whether this service can actually
understand speech. This closes that loop with the real model stack on both
sides — the TTS pool speaks a sentence, and the transcriber has to read it back.

Opt-in twice over, because it costs a model download (~460 MB) and a minute of
CPU:

    GRAVITONE_STT_E2E=1 python -m unittest service.tests.test_stt_e2e

**Run it on its own.** Every other test module installs fake ``torch`` /
``pocket_tts`` modules at import (service/tests/fake_engine.py) so the suite
runs on a box with no model stack. Those shims are process-wide, so under a
full discovery run this file would inherit them and test nothing. It detects
that and skips rather than failing in a way that looks like a real defect.
"""
from __future__ import annotations

import os
import sys
import unittest

_E2E = os.environ.get("GRAVITONE_STT_E2E") == "1"


def _shimmed() -> bool:
    """True if a sibling test module already replaced torch with a stub."""
    torch = sys.modules.get("torch")
    return torch is not None and getattr(torch, "__version__", None) is None


@unittest.skipUnless(_E2E, "set GRAVITONE_STT_E2E=1 (downloads model weights)")
class RealRoundTripTests(unittest.TestCase):
    def setUp(self) -> None:
        if _shimmed():
            self.skipTest("fake torch is loaded — run this module on its own")

    def test_the_service_understands_its_own_voice(self) -> None:
        from service import stt
        from service.convai import wav_to_pcm
        from service.engine import TtsEngine

        spoken = "We deploy the service with Kubernetes and PostgreSQL."
        engine = TtsEngine()
        engine.start()
        try:
            job = engine.submit(voice_id="alba", text=spoken)
            result = job.future.result(timeout=180)
        finally:
            engine.stop(drain_timeout_s=5)

        heard = stt.transcribe_pcm(wav_to_pcm(result.wav_bytes, 16000),
                                   language="en",
                                   hotwords="Kubernetes PostgreSQL")
        text = heard.text.lower()
        print(f"\n  said:  {spoken}\n  heard: {heard.text}\n"
              f"  {heard.duration_s:.1f}s of audio in {heard.transcribe_s:.2f}s "
              f"({heard.realtime_factor()}x realtime)")
        # The two domain nouns are the assertion. They are exactly the class of
        # word a hosted ASR needed a configured keyword list to survive, and
        # getting them right locally — per request — is the point of the module.
        self.assertIn("kubernetes", text)
        self.assertIn("postgresql", text)


if __name__ == "__main__":
    unittest.main()
