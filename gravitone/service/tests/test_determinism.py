"""The determinism contract — see ``docs/DETERMINISM.md``.

Gravitone's positioning claim is that emotion here is *auditioned rather than
rolled*: you record a Voice, you listen to it, and that is the thing the API
speaks with. A claim like that is worth exactly the part of it that is true, so
this module pins both halves.

**True, and asserted here:**

  * ``emotions.resolve`` is a pure function — same Character state, same answer,
    independent of mapping insertion order, on the hit path and on every step of
    the fallback walk. An emotion is a different EMBEDDING, not a temperature
    and not a prompt, so selecting one is arithmetic over the registry.
  * Distinct emotions select distinct Voices, so an audition of the scale is N
    different recordings rather than one take wearing N labels.
  * ``app._overrides`` is a pure, seedless function of what the caller sent —
    nothing in this service perturbs a request on its way to the model.
  * An identical request is REPLAYED byte-for-byte while its render is held
    (``service/cache.py``), which is what makes an A/B between two takes mean
    anything: pressing play twice cannot change what you hear.

**Not true, and asserted NOT to be claimed:**

  * A cold re-render is not byte-identical. Pocket TTS samples at ``temp`` and
    nothing on this path seeds an RNG. The cache-bypass test below therefore
    asserts that a bypass RE-RENDERS — it deliberately does not assert that the
    bytes match, because that assertion is the lie the whole document exists to
    avoid.

The negative control matters more than any other test here: the suite's fake
engine returns DIFFERENT bytes for every render, and
``NegativeControlTests`` proves it. Without that, every byte-equality
assertion below would pass against a constant and prove nothing at all.
"""
from __future__ import annotations

import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
from service.emotions import EMOTION_SCALE, resolve
from fastapi.testclient import TestClient

# One Character across four slots. `sad`/`whisper` are deliberately absent so
# the fallback walk is exercised by the same fixture.
_EMAP = {
    "baseline": "v_base",
    "calm": "v_calm",
    "happy": "v_happy",
    "excited": "v_excited",
}


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_settings = appmod.SETTINGS
        self._orig_emap = appmod.emotion_map
        appmod.SYNTH_CACHE.clear()
        appmod.SYNTH_CACHE.resize(8 * 1024 * 1024)
        self.engine = fake_engine.FakeEngine(workers=2, delay=0.01)
        appmod.ENGINE = self.engine
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        self.engine.close()
        appmod.ENGINE = self._orig_engine
        appmod.SETTINGS = self._orig_settings
        appmod.emotion_map = self._orig_emap
        appmod.SYNTH_CACHE.clear()
        appmod.SYNTH_CACHE.resize(self._orig_settings.cache_bytes)

    def post(self, body: dict, voice: str = "alba", headers: dict | None = None,
             **params):
        return self.client.post(
            f"/v1/text-to-speech/{voice}",
            params={"output_format": "wav_24000", **params},
            json=body, headers=headers or {})


# ---------------------------------------------------------------------------
# 1. Emotion resolution: the part of the claim that is arithmetic
# ---------------------------------------------------------------------------
class EmotionResolutionIsPureTests(unittest.TestCase):
    def test_the_same_question_gets_the_same_answer_every_time(self) -> None:
        for emotion in EMOTION_SCALE:
            with self.subTest(emotion=emotion):
                answers = {resolve(emotion, dict(_EMAP)) for _ in range(5)}
                self.assertEqual(len(answers), 1,
                                 "resolve must not depend on anything but its inputs")

    def test_the_answer_does_not_depend_on_mapping_order(self) -> None:
        # A registry read that happened to produce a differently-ordered dict
        # must not change which Voice speaks. `sad` is absent, so this walks the
        # fallback chain (sad -> calm) rather than the trivial hit path.
        forward = resolve("sad", dict(_EMAP))
        backward = resolve("sad", {k: _EMAP[k] for k in reversed(list(_EMAP))})
        self.assertEqual(forward, backward)
        self.assertEqual(forward[1], "calm")
        self.assertTrue(forward[2], "a substitution must report itself")

    def test_an_absent_emotion_with_no_chain_lands_deterministically(self) -> None:
        # A custom emotion has no FALLBACK_CHAIN entry and no prosody prior, so
        # it takes the deterministic tail. It must land on baseline — never on
        # "whichever key came first".
        answers = {resolve("sarcastic", {k: _EMAP[k] for k in order})
                   for order in (list(_EMAP), list(reversed(list(_EMAP))))}
        self.assertEqual(answers, {("v_base", "baseline", True)})

    def test_distinct_emotions_are_distinct_voices(self) -> None:
        # The audition's whole premise: asking for four emotions gets four
        # different recordings. If two slots resolved to one voice, the matrix
        # would present the same take twice as a range.
        recorded = [e for e in EMOTION_SCALE if e in _EMAP]
        voices = [resolve(e, dict(_EMAP))[0] for e in recorded]
        self.assertEqual(len(set(voices)), len(recorded))


# ---------------------------------------------------------------------------
# 2. The sampling knobs: a fixed function of the request, with no seed
# ---------------------------------------------------------------------------
class SamplingKnobsArePureTests(unittest.TestCase):
    def _settings(self, **kw):
        return appmod.VoiceSettings(**kw)

    def test_the_same_settings_map_to_the_same_overrides(self) -> None:
        vs = self._settings(temperature=0.65, stability=0.4, quality=3)
        self.assertEqual(appmod._overrides(vs), appmod._overrides(vs))
        # And a second, equal-but-distinct object agrees — the mapping reads the
        # values, never the object.
        self.assertEqual(appmod._overrides(vs),
                         appmod._overrides(self._settings(temperature=0.65,
                                                          stability=0.4, quality=3)))

    def test_nothing_seed_shaped_reaches_the_model(self) -> None:
        # A seed knob was considered and deliberately NOT shipped
        # (docs/DETERMINISM.md, "Why a seed knob was not added"). The ElevenLabs
        # compat surface DOES declare `seed` on TTSRequest — so an unmodified EL
        # client is not rejected and the drop is reported on X-Ignored-Settings
        # rather than silent — but declared-and-inert is the only shape it may
        # have: the moment it leaves _INERT_REQUEST_FIELDS or shows up in
        # _overrides, someone has half-wired a guarantee we cannot keep, and the
        # document must change in the same commit.
        keys = set(appmod._overrides(self._settings(temperature=0.7)))
        self.assertNotIn("seed", keys)
        self.assertFalse({k for k in keys if "seed" in k or "rand" in k})
        self.assertIn("seed", appmod._INERT_REQUEST_FIELDS)
        self.assertNotIn("seed", appmod.VoiceSettings.model_fields)

    def test_the_inert_compatibility_settings_change_nothing(self) -> None:
        plain = appmod._overrides(self._settings(temperature=0.7))
        dressed = appmod._overrides(
            self._settings(temperature=0.7, similarity_boost=0.9, style=0.5))
        self.assertEqual(plain, dressed)


# ---------------------------------------------------------------------------
# 3. The negative control — without this, everything below is vacuous
# ---------------------------------------------------------------------------
class NegativeControlTests(_Base):
    def test_the_engine_really_does_render_different_bytes_each_time(self) -> None:
        first = self.post({"text": "Control."}, headers={"Cache-Control": "no-store"})
        second = self.post({"text": "Control."}, headers={"Cache-Control": "no-store"})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertNotEqual(
            first.content, second.content,
            "the fake engine must NOT be constant, or byte-identity below "
            "proves nothing about replay")


# ---------------------------------------------------------------------------
# 4. Replay: what "the same request returns the same audio" actually means
# ---------------------------------------------------------------------------
class ReplayIsByteIdenticalTests(_Base):
    def test_an_identical_request_is_replayed_not_re_rolled(self) -> None:
        body = {"text": "Say it again.", "voice_settings": {"temperature": 0.7}}
        first = self.post(body)
        second = self.post(body)
        self.assertEqual(first.headers["x-cache"], "miss")
        self.assertEqual(second.headers["x-cache"], "hit")
        self.assertEqual(second.content, first.content)
        self.assertEqual(len(self.engine.jobs), 1, "a replay must not synthesize")

    def test_an_inert_setting_does_not_break_the_replay(self) -> None:
        # similarity_boost/style cannot change the audio, so a request that adds
        # them is the SAME synthesis and must replay rather than re-roll.
        self.post({"text": "Inert."})
        again = self.post({"text": "Inert.",
                           "voice_settings": {"similarity_boost": 0.4, "style": 0.2}})
        self.assertEqual(again.headers["x-cache"], "hit")
        self.assertEqual(len(self.engine.jobs), 1)

    def test_one_emotion_address_replays_and_two_do_not(self) -> None:
        appmod.emotion_map = lambda cid: dict(_EMAP)
        happy = self.post({"text": "Feelings."}, voice="sarah:happy")
        happy_again = self.post({"text": "Feelings."}, voice="sarah:happy")
        calm = self.post({"text": "Feelings."}, voice="sarah:calm")

        # Same address, same bytes — this is what makes the audition matrix's
        # "play them back to back" comparison honest.
        self.assertEqual(happy_again.content, happy.content)
        self.assertEqual(happy_again.headers["x-cache"], "hit")
        # Different address, different Voice, different audio.
        self.assertEqual(calm.headers["x-cache"], "miss")
        self.assertNotEqual(calm.content, happy.content)
        self.assertEqual(calm.headers["x-emotion-used"], "calm")


# ---------------------------------------------------------------------------
# 5. The honest boundary — where the promise stops
# ---------------------------------------------------------------------------
class WhereDeterminismStopsTests(_Base):
    def test_a_bypass_re_renders_and_says_so(self) -> None:
        # Deliberately NOT an assertion that the bytes match. A cold re-render
        # is a fresh sample from the model and Gravitone does not claim
        # otherwise; what IS asserted is that the bypass really bypassed, so the
        # boundary in docs/DETERMINISM.md is where the code puts it.
        self.post({"text": "Bypass."})
        bypassed = self.post({"text": "Bypass."},
                             headers={"X-Gravitone-Cache": "bypass"})
        self.assertEqual(bypassed.headers["x-cache"], "bypass")
        self.assertEqual(len(self.engine.jobs), 2, "a bypass must synthesize")

    def test_a_bypass_does_not_poison_the_held_render(self) -> None:
        # The cached take a user is A/B-ing must survive somebody else's
        # benchmark run: a bypass stores nothing, so the next ordinary request
        # still replays the ORIGINAL bytes rather than the benchmark's.
        first = self.post({"text": "Untouched."})
        self.post({"text": "Untouched."}, headers={"Cache-Control": "no-store"})
        after = self.post({"text": "Untouched."})
        self.assertEqual(after.headers["x-cache"], "hit")
        self.assertEqual(after.content, first.content)

    def test_re_cloning_a_voice_is_allowed_to_change_the_audio(self) -> None:
        # Determinism must never become staleness: the key holds a fingerprint
        # of the embedding, so a re-cloned Voice invalidates its own audio.
        # (The fingerprint of an unknown/builtin voice is the constant
        # "builtin", so this is asserted at the key level.)
        key = appmod._cache_key("v_base", "Hi.", {}, None)
        same = appmod._cache_key("v_base", "Hi.", {}, None)
        other = appmod._cache_key("v_happy", "Hi.", {}, None)
        self.assertEqual(key, same)
        self.assertNotEqual(key, other)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
