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

from service.tests import fake_engine
from service import ratelimit  # installs shims — must precede app import

import service.app as appmod
import service.engine as enginemod
from service.engine import resample_pcm16
from fastapi.testclient import TestClient

import numpy as np


class _Base(unittest.TestCase):
    def setUp(self) -> None:

        ratelimit.reset_all()  # demo per-IP budgets are process-global; a heavy suite must not 429 itself
        self._orig = appmod.ENGINE
        appmod.SYNTH_CACHE.clear()  # process-wide singleton — isolate cases
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delay=0.01)
        self.client = TestClient(appmod.app)
        import scipy.signal  # the fake shim installed by fake_engine
        scipy.signal.resample_poly.calls.clear()

    def tearDown(self) -> None:
        # Shut the fake's ThreadPoolExecutor: swapping the module reference and
        # dropping the object leaked one pool (2 threads) PER TEST CASE for the
        # whole run, and leaked workers could still be mutating the shared
        # resample_poly.calls list during a later test.
        eng = appmod.ENGINE
        if isinstance(eng, fake_engine.FakeEngine):
            eng.close()
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
            "/v1/text-to-speech/alba", params={"output_format": output_format},
            json={"text": "Hello world.", **kw})

    def test_mp3_bitrate_reaches_ffmpeg(self) -> None:
        captured = {}

        # **kw so the stub mirrors subprocess.run's tolerance: a rigid signature
        # here breaks the moment production passes a new kwarg (it did — the
        # ffmpeg timeout), turning a source improvement into a fake test failure.
        def fake_run(cmd, input=None, stdout=None, stderr=None, **kw):
            captured["cmd"] = cmd
            captured["kw"] = kw
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
        # The encoder MUST be wall-clock bounded: an unbounded ffmpeg pins the
        # worker thread forever with no request-timeout escape.
        self.assertTrue(captured["kw"].get("timeout"), "ffmpeg must be given a timeout")

    def test_mp3_non_native_rate_sets_ar(self) -> None:
        captured = {}

        def fake_run(cmd, input=None, stdout=None, stderr=None, **kw):
            captured["cmd"] = cmd
            captured["kw"] = kw
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
            "/v1/text-to-speech/alba", params={"output_format": "wav_24000"},
            json={"text": "Hi.", "voice_settings": {"similarity_boost": 0.5, "style": 0.3}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-ignored-settings"], "similarity_boost,style")

    def test_no_header_when_not_sent(self) -> None:
        r = self.client.post(
            "/v1/text-to-speech/alba", params={"output_format": "wav_24000"},
            json={"text": "Hi.", "voice_settings": {"temperature": 0.7}})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("x-ignored-settings", r.headers)


# The body an UNMODIFIED ElevenLabs client sends today: every field the current
# text_to_speech.convert / .stream contract can put on the wire. The one thing
# this file exists to guarantee is that this dict never produces a 422.
ELEVENLABS_BODY = {
    "text": "Same request, new base URL.",
    "model_id": "eleven_multilingual_v2",
    "language_code": "en",
    "voice_settings": {
        "stability": 0.5,
        "similarity_boost": 0.75,
        "style": 0.2,
        "use_speaker_boost": True,
        "speed": 1.0,
    },
    "seed": 12345,
    "previous_text": "The sentence before.",
    "next_text": "The sentence after.",
    "previous_request_ids": ["req_a"],
    "next_request_ids": ["req_b"],
    "pronunciation_dictionary_locators": [
        {"pronunciation_dictionary_id": "pd_1", "version_id": "v_1"}],
    "apply_text_normalization": "auto",
    "apply_language_text_normalization": False,
    "use_pvc_as_ivc": False,
}


class UnmodifiedElevenLabsClientTests(_Base):
    """A stock EL SDK request must synthesize — never 422, never silently.

    Two halves, and both matter:
      * every field above is ACCEPTED (the drop-in promise), and
      * every field we cannot act on is NAMED on X-Ignored-Settings (the
        honesty promise — a parameter that silently does nothing is a bug
        report waiting to happen).
    """

    def test_full_elevenlabs_body_synthesizes(self) -> None:
        r = self.client.post("/v1/text-to-speech/alba", json=ELEVENLABS_BODY)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["content-type"], "audio/wav")
        self.assertEqual(r.content[:4], b"RIFF")

    def test_no_elevenlabs_field_is_a_422(self) -> None:
        """Each field ALONE, so one bad annotation can't hide behind another."""
        for key, value in ELEVENLABS_BODY.items():
            if key == "text":
                continue
            with self.subTest(field=key):
                r = self.client.post("/v1/text-to-speech/alba",
                                     json={"text": "Hi.", key: value})
                self.assertEqual(r.status_code, 200, f"{key}: {r.text}")

    def test_every_inert_field_is_named_on_the_header(self) -> None:
        r = self.client.post("/v1/text-to-speech/alba", json=ELEVENLABS_BODY)
        named = set(r.headers["x-ignored-settings"].split(","))
        # voice_settings level
        for f in ("similarity_boost", "style", "use_speaker_boost", "speed"):
            self.assertIn(f, named)
        # top level
        for f in appmod._INERT_REQUEST_FIELDS:
            self.assertIn(f, named)
        # ...and the ones we DO honour are not slandered as ignored.
        for f in ("stability", "temperature", "quality", "model_id", "text"):
            self.assertNotIn(f, named)

    def test_honoured_settings_survive_the_inert_ones(self) -> None:
        """stability still maps, and the inert fields add no phantom overrides.

        The risk this pins is the opposite of a 422: that accepting more fields
        quietly starts sending something extra to the model. The override dict
        an EL-shaped body produces must be EXACTLY the stability mapping.
        """
        vs = appmod.VoiceSettings(**ELEVENLABS_BODY["voice_settings"])
        # stability 0.5 -> 2.5 - 2.0*0.5 = 1.5, and nothing else.
        self.assertEqual(appmod._overrides(vs), {"noise_clamp": 1.5})

    def test_top_level_fields_only_reported_when_sent(self) -> None:
        """model_fields_set, not value: an unsent field is not "ignored"."""
        r = self.client.post("/v1/text-to-speech/alba",
                             json={"text": "Hi.", "seed": 7})
        self.assertEqual(r.headers["x-ignored-settings"], "seed")

    def test_false_valued_field_is_still_reported(self) -> None:
        """`use_pvc_as_ivc: false` was SENT — a value-only check would miss it."""
        r = self.client.post("/v1/text-to-speech/alba",
                             json={"text": "Hi.", "use_pvc_as_ivc": False,
                                   "apply_language_text_normalization": False})
        named = r.headers["x-ignored-settings"].split(",")
        self.assertIn("use_pvc_as_ivc", named)
        self.assertIn("apply_language_text_normalization", named)

    def test_elevenlabs_stream_default_format_succeeds(self) -> None:
        """The EL SDK streams mp3_44100_128 by default; it must not 501."""
        captured: dict = {}

        def fake_run(cmd, input=None, stdout=None, stderr=None, **kw):
            captured["cmd"] = cmd
            import types as _t
            return _t.SimpleNamespace(returncode=0, stdout=b"MP3DATA", stderr=b"")

        orig = enginemod.subprocess.run
        enginemod.subprocess.run = fake_run
        try:
            r = self.client.post("/v1/text-to-speech/alba/stream",
                                 params={"output_format": "mp3_44100_128"},
                                 json=ELEVENLABS_BODY)
        finally:
            enginemod.subprocess.run = orig
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["content-type"], "audio/mpeg")
        # Not a stream, and it says so rather than pretending.
        self.assertEqual(r.headers["x-stream"], "full-body")
        self.assertIn("cannot be transcoded incrementally",
                      r.headers["x-stream-fallback"])
        # The requested rate still reached ffmpeg — the fallback is about
        # chunking, not about ignoring the format.
        self.assertEqual(captured["cmd"][captured["cmd"].index("-ar") + 1], "44100")

    def test_stream_with_timestamps_alias_is_not_a_404(self) -> None:
        """EL's /stream/with-timestamps path resolves to our handler.

        Whether it then answers 200 or 501 depends on whether this replica has
        a transcriber (the alignment is computed by listening — see the route's
        docstring). What it must never be again is 404, which reads to a
        migrating client as "you typed the URL wrong".
        """
        r = self.client.post("/v1/text-to-speech/alba/stream/with-timestamps",
                             json=ELEVENLABS_BODY)
        self.assertNotEqual(r.status_code, 404)
        self.assertIn(r.status_code, (200, 501))


class MigrationGuideClaimsTests(_Base):
    """Claims docs/SWITCH_FROM_ELEVENLABS.md makes, pinned to the code.

    A migration guide is a promise to someone who has not run the code yet, so
    every row of its tables has to be a fact about this build rather than an
    aspiration. These are the claims that are not already covered above.
    """

    def test_unknown_query_params_are_ignored_not_rejected(self) -> None:
        """"Unknown query parameters ... never fail a request"."""
        r = self.client.post(
            "/v1/text-to-speech/alba",
            params={"output_format": "wav_24000",
                    "optimize_streaming_latency": 3,
                    "enable_logging": "true",
                    "a_param_that_does_not_exist": "x"},
            json={"text": "Hi."})
        self.assertEqual(r.status_code, 200, r.text)

    def test_unsupported_format_families_are_400_not_a_substitution(self) -> None:
        """"ogg_*, ulaw_*, alaw_* -> 400, listing the supported grammar"."""
        for bad in ("ogg_24000", "ulaw_8000", "alaw_8000", "flac"):
            with self.subTest(output_format=bad):
                r = self.client.post("/v1/text-to-speech/alba",
                                     params={"output_format": bad},
                                     json={"text": "Hi."})
                self.assertEqual(r.status_code, 400)
                self.assertIn("Supported", r.json()["detail"])

    def test_there_is_no_credit_meter_to_read(self) -> None:
        """"GET /v1/user, /v1/user/subscription -> 404, on purpose".

        This asserts an ABSENCE, deliberately: the guide tells a migrating
        developer to delete their quota-guard code, and that instruction is only
        safe while these endpoints do not exist. If someone ever adds a
        subscription surface, this test should fail and the guide should change
        with it.
        """
        for path in ("/v1/user", "/v1/user/subscription"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_repeatability_is_offered_by_digest_since_seed_is_inert(self) -> None:
        """The guide sends `seed` users to X-Speech-Digest + If-None-Match."""
        r = self.client.post("/v1/text-to-speech/alba", json={"text": "Hi."})
        digest = r.headers["x-speech-digest"]
        self.assertTrue(digest.startswith("sha256:"))
        again = self.client.post("/v1/text-to-speech/alba", json={"text": "Hi."},
                                 headers={"If-None-Match": r.headers["etag"]})
        self.assertEqual(again.status_code, 304)

    def test_the_guides_curl_and_fetch_shape_synthesizes(self) -> None:
        """The exact shape of the curl / requests / fetch examples."""
        r = self.client.post(
            "/v1/text-to-speech/alba",
            params={"output_format": "mp3_44100_128"},
            headers={"xi-api-key": "anything", "Content-Type": "application/json"},
            json={"text": "Same request, no per-character bill."})
        # ffmpeg may or may not exist on this box; what the guide promises is
        # that the REQUEST is accepted, not that this machine can encode mp3.
        self.assertNotIn(r.status_code, (400, 422), r.text)


class VoiceLabelsTests(_Base):
    def test_labels_are_present_and_derived_from_the_row(self) -> None:
        v = self.client.get("/v1/voices").json()["voices"][0]
        self.assertIn("labels", v)
        labels = v["labels"]
        # Every value restates a field of the SAME voice — nothing invented.
        self.assertEqual(labels["character"], v["character_id"])
        self.assertEqual(labels["emotion"], v["emotion"])
        self.assertEqual(labels["language"], v["lang"].lower())
        self.assertEqual(labels["origin"], v["origin"])

    def test_no_guessed_elevenlabs_labels(self) -> None:
        """We do not know a cloned voice's accent/age/gender. So we don't say."""
        labels = self.client.get("/v1/voices").json()["voices"][0]["labels"]
        for guessed in ("accent", "age", "gender", "use case", "descriptive"):
            self.assertNotIn(guessed, labels)


class PremiumRouteFormatTests(_Base):
    """/v1/speak and /v1/performance honour the SAME output_format grammar.

    The two routes that are Gravitone's actual differentiator were the two you
    could not get an mp3 out of — which matters most for a multi-character
    performance, the output someone would want to share. One parser
    (``_parse_format``), one renderer (``_encode_audio``), three routes.
    """

    _EMAP = {"baseline": "v_base", "happy": "v_happy", "sad": "v_sad"}

    def setUp(self) -> None:

        ratelimit.reset_all()  # demo per-IP budgets are process-global; a heavy suite must not 429 itself
        super().setUp()
        self._orig_emap = appmod.emotion_map
        appmod.emotion_map = lambda cid: dict(self._EMAP)

    def tearDown(self) -> None:
        appmod.emotion_map = self._orig_emap
        super().tearDown()

    def _speak(self, **params):
        return self.client.post(
            "/v1/speak", params=params,
            json={"character_id": "sarah", "text": "[happy]Hello[/happy] [sad]World"})

    def _performance(self, **params):
        return self.client.post(
            "/v1/performance", params=params,
            json={"lines": [{"character_id": "sarah", "text": "[happy]Hello"},
                            {"character_id": "sarah", "text": "[sad]World"}]})

    def _fake_ffmpeg(self, captured: dict):
        def fake_run(cmd, input=None, stdout=None, stderr=None, **kw):
            captured["cmd"] = cmd
            import types as _t
            return _t.SimpleNamespace(returncode=0, stdout=b"MP3DATA", stderr=b"")

        orig = enginemod.subprocess.run
        enginemod.subprocess.run = fake_run
        self.addCleanup(setattr, enginemod.subprocess, "run", orig)

    def test_default_is_native_wav_on_both_routes(self) -> None:
        # No output_format at all: byte-identical to before the parameter
        # existed — a RIFF body at the native rate, no resample, no X-Sample-Rate.
        import scipy.signal
        for name, call in (("speak", self._speak), ("performance", self._performance)):
            with self.subTest(route=name):
                scipy.signal.resample_poly.calls.clear()
                r = call()
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.headers["content-type"], "audio/wav")
                self.assertEqual(r.content[:4], b"RIFF")
                self.assertNotIn("x-sample-rate", r.headers)
                self.assertEqual(scipy.signal.resample_poly.calls, [])

    def test_mp3_is_transcoded_at_the_requested_bitrate(self) -> None:
        for name, call in (("speak", self._speak), ("performance", self._performance)):
            with self.subTest(route=name):
                captured: dict = {}
                self._fake_ffmpeg(captured)
                r = call(output_format="mp3_24000_192")
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.headers["content-type"], "audio/mpeg")
                self.assertEqual(r.content, b"MP3DATA")
                cmd = captured["cmd"]
                self.assertEqual(cmd[cmd.index("-b:a") + 1], "192k")
                self.assertNotIn("-ar", cmd)  # native rate needs no ffmpeg -ar
                # The report headers survive the format change.
                self.assertIn("x-segments" if name == "speak"
                              else "x-performance-report", r.headers)

    def test_mp3_non_native_rate_sets_ar(self) -> None:
        captured: dict = {}
        self._fake_ffmpeg(captured)
        r = self._performance(output_format="mp3_44100_128")
        self.assertEqual(r.status_code, 200)
        cmd = captured["cmd"]
        self.assertEqual(cmd[cmd.index("-ar") + 1], "44100")

    def test_pcm_strips_the_header_and_reports_the_rate(self) -> None:
        import scipy.signal
        for name, call in (("speak", self._speak), ("performance", self._performance)):
            with self.subTest(route=name):
                scipy.signal.resample_poly.calls.clear()
                r = call(output_format="pcm_16000")
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.headers["content-type"],
                                 "application/octet-stream")
                self.assertEqual(r.headers["x-sample-rate"], "16000")
                self.assertNotEqual(r.content[:4], b"RIFF")
                # 24000 -> 16000 : up=2, down=3
                self.assertTrue(
                    any(c[1:] == (2, 3) for c in scipy.signal.resample_poly.calls))

    def test_wav_non_native_resamples(self) -> None:
        import scipy.signal
        scipy.signal.resample_poly.calls.clear()
        r = self._speak(output_format="wav_48000")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "audio/wav")
        self.assertEqual(r.content[:4], b"RIFF")
        self.assertTrue(
            any(c[1:] == (2, 1) for c in scipy.signal.resample_poly.calls))

    def test_unsupported_format_400s_before_any_synthesis(self) -> None:
        for name, call in (("speak", self._speak), ("performance", self._performance)):
            with self.subTest(route=name):
                eng = fake_engine.FakeEngine(workers=2, delay=0.01)
                appmod.ENGINE.close()
                appmod.ENGINE = eng
                r = call(output_format="ogg_24000")
                self.assertEqual(r.status_code, 400)
                self.assertIn("Supported", r.json()["detail"])
                # Early: a bad format must not burn a worker on audio nobody
                # can be handed.
                self.assertEqual(len(eng.jobs), 0)


class StreamResampleTests(_Base):
    def test_stream_pcm_resamples_per_segment(self) -> None:
        import dataclasses
        import scipy.signal
        # One segment per sentence: at the production chunk budget (350 chars)
        # this two-sentence fixture is a single unit and couldn't show
        # PER-SEGMENT resampling, which is what this pins.
        self.addCleanup(setattr, appmod, "SETTINGS", appmod.SETTINGS)
        appmod.SETTINGS = dataclasses.replace(appmod.SETTINGS, chunk_chars=1)
        scipy.signal.resample_poly.calls.clear()
        with self.client.stream(
            "POST", "/v1/text-to-speech/alba/stream",
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
