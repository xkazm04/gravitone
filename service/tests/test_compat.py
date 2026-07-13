"""ElevenLabs drop-in compatibility — response shapes, formats, ignored settings.

Verified with the fake engine + fake scipy shim (no real model / DSP):
  * GET /v1/voices is `{"voices": [...]}`; single-voice + /v1/models exist.
  * output_format grammar is parsed and honoured — mp3 bitrate/rate reach
    ffmpeg, pcm/wav non-native rates resample (right up/down factors), native
    rates do NOT resample, unsupported combos 400 with the supported grammar.
  * PCM content-type is application/octet-stream + X-Sample-Rate.
  * similarity_boost / style are surfaced via X-Ignored-Settings, never silent.
"""
from __future__ import annotations

import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.engine as enginemod
from service.engine import resample_pcm16
from fastapi.testclient import TestClient

import numpy as np


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = appmod.ENGINE
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delay=0.01)
        self.client = TestClient(appmod.app)
        import scipy.signal  # the fake shim installed by fake_engine
        scipy.signal.resample_poly.calls.clear()

    def tearDown(self) -> None:
        appmod.ENGINE = self._orig


class ResponseShapeTests(_Base):
    def test_voices_is_wrapped_object(self) -> None:
        r = self.client.get("/v1/voices")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIsInstance(body, dict)
        self.assertIn("voices", body)
        self.assertIsInstance(body["voices"], list)
        self.assertTrue(body["voices"], "expected built-in voices")
        v = body["voices"][0]
        for key in ("voice_id", "name", "category"):
            self.assertIn(key, v)

    def test_single_voice_and_404(self) -> None:
        first = self.client.get("/v1/voices").json()["voices"][0]
        r = self.client.get(f"/v1/voices/{first['voice_id']}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["voice_id"], first["voice_id"])

        miss = self.client.get("/v1/voices/does-not-exist-xyz")
        self.assertEqual(miss.status_code, 404)
        # EL-style: detail is a structured object.
        self.assertIn("detail", miss.json())

    def test_models_endpoint(self) -> None:
        r = self.client.get("/v1/models")
        self.assertEqual(r.status_code, 200)
        models = r.json()
        self.assertIsInstance(models, list)
        m = models[0]
        self.assertEqual(m["model_id"], "gravitone_pocket_v1")
        self.assertTrue(m["can_do_text_to_speech"])
        codes = [l["language_id"] for l in m["languages"]]
        self.assertIn("en", codes)


class FormatParseTests(unittest.TestCase):
    def test_valid_grammar(self) -> None:
        f = appmod._parse_format("mp3_24000_192")
        self.assertEqual((f.kind, f.sample_rate, f.bitrate), ("mp3", 24000, 192))
        self.assertEqual(f.content_type, "audio/mpeg")

        f = appmod._parse_format("pcm_16000")
        self.assertEqual((f.kind, f.sample_rate), ("pcm", 16000))
        self.assertEqual(f.content_type, "application/octet-stream")

        f = appmod._parse_format("wav_48000")
        self.assertEqual((f.kind, f.sample_rate, f.content_type), ("wav", 48000, "audio/wav"))

        # bare forms default to 24000 (mp3 -> 128k)
        self.assertEqual(appmod._parse_format("mp3").bitrate, 128)
        self.assertEqual(appmod._parse_format("pcm").sample_rate, 24000)

    def test_unsupported_raises_400_listing_grammar(self) -> None:
        from fastapi import HTTPException
        for bad in ("flac", "ogg_24000", "mp3_9999_192", "mp3_24000_999",
                    "pcm_11111", "wav_3000", "mp3_24000"):
            with self.assertRaises(HTTPException) as cm:
                appmod._parse_format(bad)
            self.assertEqual(cm.exception.status_code, 400)
            self.assertIn("Supported", cm.exception.detail)


class ResampleHelperTests(unittest.TestCase):
    def test_factors_24000_to_16000(self) -> None:
        import scipy.signal
        scipy.signal.resample_poly.calls.clear()
        samples = np.zeros(240, dtype=np.int16)
        resample_pcm16(samples, 24000, 16000)
        self.assertEqual(scipy.signal.resample_poly.calls, [(240, 2, 3)])

    def test_native_rate_is_noop(self) -> None:
        import scipy.signal
        scipy.signal.resample_poly.calls.clear()
        samples = np.zeros(240, dtype=np.int16)
        out = resample_pcm16(samples, 24000, 24000)
        self.assertEqual(scipy.signal.resample_poly.calls, [])
        self.assertIs(out, samples)


class FormatRouteTests(_Base):
    def _post(self, output_format: str, **kw):
        return self.client.post(
            "/v1/text-to-speech/v", params={"output_format": output_format},
            json={"text": "Hello world.", **kw})

    def test_mp3_bitrate_reaches_ffmpeg(self) -> None:
        captured = {}

        def fake_run(cmd, input=None, stdout=None, stderr=None):
            captured["cmd"] = cmd
            import types as _t
            return _t.SimpleNamespace(returncode=0, stdout=b"MP3DATA", stderr=b"")

        orig = enginemod.subprocess.run
        enginemod.subprocess.run = fake_run
        try:
            r = self._post("mp3_24000_192")
        finally:
            enginemod.subprocess.run = orig
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "audio/mpeg")
        self.assertEqual(r.content, b"MP3DATA")
        cmd = captured["cmd"]
        self.assertIn("-b:a", cmd)
        self.assertEqual(cmd[cmd.index("-b:a") + 1], "192k")
        # native rate (24000) -> no ffmpeg resample
        self.assertNotIn("-ar", cmd)

    def test_mp3_non_native_rate_sets_ar(self) -> None:
        captured = {}

        def fake_run(cmd, input=None, stdout=None, stderr=None):
            captured["cmd"] = cmd
            import types as _t
            return _t.SimpleNamespace(returncode=0, stdout=b"MP3DATA", stderr=b"")

        orig = enginemod.subprocess.run
        enginemod.subprocess.run = fake_run
        try:
            r = self._post("mp3_44100_128")
        finally:
            enginemod.subprocess.run = orig
        self.assertEqual(r.status_code, 200)
        cmd = captured["cmd"]
        self.assertIn("-ar", cmd)
        self.assertEqual(cmd[cmd.index("-ar") + 1], "44100")

    def test_pcm_non_native_resamples_and_headers(self) -> None:
        import scipy.signal
        scipy.signal.resample_poly.calls.clear()
        r = self._post("pcm_16000")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "application/octet-stream")
        self.assertEqual(r.headers["x-sample-rate"], "16000")
        # resample happened at 24000->16000 (up=2, down=3)
        self.assertTrue(any(c[1:] == (2, 3) for c in scipy.signal.resample_poly.calls))
        # raw PCM, no WAV header
        self.assertNotEqual(r.content[:4], b"RIFF")

    def test_pcm_native_does_not_resample(self) -> None:
        import scipy.signal
        scipy.signal.resample_poly.calls.clear()
        r = self._post("pcm_24000")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-sample-rate"], "24000")
        self.assertEqual(scipy.signal.resample_poly.calls, [])

    def test_wav_non_native_resamples(self) -> None:
        import scipy.signal
        scipy.signal.resample_poly.calls.clear()
        r = self._post("wav_48000")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "audio/wav")
        self.assertEqual(r.content[:4], b"RIFF")
        # 24000 -> 48000 : up=2, down=1
        self.assertTrue(any(c[1:] == (2, 1) for c in scipy.signal.resample_poly.calls))

    def test_unsupported_format_returns_400(self) -> None:
        r = self._post("ogg_24000")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Supported", r.json()["detail"])


class IgnoredSettingsTests(_Base):
    def test_similarity_boost_and_style_surfaced(self) -> None:
        r = self.client.post(
            "/v1/text-to-speech/v", params={"output_format": "wav_24000"},
            json={"text": "Hi.", "voice_settings": {"similarity_boost": 0.5, "style": 0.3}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-ignored-settings"], "similarity_boost,style")

    def test_no_header_when_not_sent(self) -> None:
        r = self.client.post(
            "/v1/text-to-speech/v", params={"output_format": "wav_24000"},
            json={"text": "Hi.", "voice_settings": {"temperature": 0.7}})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("x-ignored-settings", r.headers)


class StreamResampleTests(_Base):
    def test_stream_pcm_resamples_per_segment(self) -> None:
        import scipy.signal
        scipy.signal.resample_poly.calls.clear()
        with self.client.stream(
            "POST", "/v1/text-to-speech/v/stream",
            params={"output_format": "pcm_16000"},
            json={"text": "One. Two."},
        ) as resp:
            self.assertEqual(resp.headers["x-sample-rate"], "16000")
            resp.read()
        # two segments each resampled 24000->16000
        calls = [c[1:] for c in scipy.signal.resample_poly.calls]
        self.assertEqual(calls, [(2, 3), (2, 3)])


if __name__ == "__main__":
    unittest.main()
