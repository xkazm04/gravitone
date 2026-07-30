"""Speech as a build artifact: identity, the durable store, and the build plane.

What is pinned here:

  * **The golden digest manifest.** A fixture of four lines is hashed to four
    EXACT strings. This is the enforcement half of the DIGEST LAW: any silent
    change to normalization, to the identity payload's shape, or to the version
    constants fails right here, loudly, instead of quietly turning every
    lockfile in every user's repository into a lie.
  * **One identity, two routes.** A plain ``POST /v1/text-to-speech`` and a
    ``POST /v1/build`` line with identical inputs must report the SAME digest —
    that equality is the entire product claim, so it is asserted directly.
  * ``If-None-Match`` answers 304 having synthesized NOTHING (asserted against
    the fake engine's job list, not merely by status code).
  * The store: atomic writes, LRU pruning under a named budget, a named 404 for
    an absent digest, and no path escapes from a caller-supplied digest.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.buildstore as buildstore
from fastapi.testclient import TestClient


# The engine/segmentation strings the golden digests were computed under.
# They are passed EXPLICITLY (never read from SETTINGS) so this fixture is a
# statement about the identity function itself and cannot be moved by an
# operator's TTS_CHUNK_CHARS or a box with a different worker count.
GOLDEN_ENGINE = "pocket_tts/1/lang=english/quant=0/max_tokens=50"
GOLDEN_SEGMENTATION = "sentence-coalesce/1/chunk=350/units=1"

# id -> (voice_id, fingerprint, text, overrides, frames_after_eos, format)
GOLDEN_MANIFEST = {
    "plain-wav": ("alba", "builtin", "Hello world.", {}, None, "wav_24000"),
    "same-line-as-mp3": ("alba", "builtin", "Hello world.", {"temp": 0.7},
                         None, "mp3_24000_128"),
    "cloned-voice-pcm": ("sarah_excited", "1700000000000000000:4096",
                         "The quick brown fox.",
                         {"temp": 0.9, "noise_clamp": 1.5}, 3, "pcm_16000"),
    "two-sentences": ("alba", "builtin", "Line one.\nLine two.", {}, None,
                      "wav_48000"),
}

GOLDEN_DIGESTS = {
    "plain-wav":
        "sha256:188117a60f63cb2f5a8e497f8f7824ec05e50827f2e969ca093dc4ca9562274d",
    "same-line-as-mp3":
        "sha256:a880cc7a6af3b3883cd708d6c004199df61334addd43fbd0357dd76f85b3f260",
    "cloned-voice-pcm":
        "sha256:a0706ac6d17aa841c7e8f768973dcf6e3e27c407f2c915dc7474783ed1372a30",
    "two-sentences":
        "sha256:08c75102053efc8649d7ef4544ce0f965d16438da54791c454bd90cb0ee79c22",
}


def _digest(line, **overrides) -> str:
    voice_id, fingerprint, text, knobs, frames, fmt = line
    kwargs = dict(voice_id=voice_id, voice_fingerprint=fingerprint, text=text,
                  overrides=knobs, frames_after_eos=frames, output_format=fmt,
                  engine_version=GOLDEN_ENGINE, segmentation=GOLDEN_SEGMENTATION)
    kwargs.update(overrides)
    return buildstore.speech_digest(**kwargs)


class GoldenDigestTests(unittest.TestCase):
    """The DIGEST LAW, enforced.

    If one of these fails, do NOT edit the expected string to make it pass
    unless the change was deliberate — a moved digest means every previously
    stored artifact is now unreachable under its old name. Bump
    ``IDENTITY_VERSION`` (or ``MODEL_VERSION`` / ``SEGMENTATION_VERSION``) and
    re-pin the fixture in the same commit that changed the behaviour.
    """

    def test_fixture_manifest_hashes_to_the_pinned_digests(self) -> None:
        for line_id, line in GOLDEN_MANIFEST.items():
            with self.subTest(line=line_id):
                self.assertEqual(_digest(line), GOLDEN_DIGESTS[line_id])

    def test_every_component_actually_moves_the_digest(self) -> None:
        base = GOLDEN_MANIFEST["plain-wav"]
        original = _digest(base)
        mutations = {
            "voice_id": {"voice_id": "other"},
            "fingerprint": {"voice_fingerprint": "1:2"},
            "text": {"text": "Hello world!"},
            "overrides": {"overrides": {"temp": 0.7}},
            "frames_after_eos": {"frames_after_eos": 2},
            "format": {"output_format": "mp3_24000_128"},
            "engine_version": {"engine_version": GOLDEN_ENGINE + "x"},
            "segmentation": {"segmentation": GOLDEN_SEGMENTATION + "x"},
        }
        for name, mutation in mutations.items():
            with self.subTest(component=name):
                self.assertNotEqual(_digest(base, **mutation), original)

    def test_identity_version_is_part_of_the_hash(self) -> None:
        original = _digest(GOLDEN_MANIFEST["plain-wav"])
        prior = buildstore.IDENTITY_VERSION
        buildstore.IDENTITY_VERSION = prior + "-next"
        try:
            self.assertNotEqual(_digest(GOLDEN_MANIFEST["plain-wav"]), original)
        finally:
            buildstore.IDENTITY_VERSION = prior

    def test_normalization_is_conservative(self) -> None:
        base = GOLDEN_MANIFEST["two-sentences"]
        # Line endings and outer whitespace are normalized away...
        for equal in ("Line one.\r\nLine two.", "  Line one.\nLine two.  \n"):
            with self.subTest(text=equal):
                self.assertEqual(_digest(base, text=equal), _digest(base))
        # ...and nothing else is. Inner spacing, case and punctuation all
        # produce different audio, so they must produce different names.
        for different in ("Line  one.\nLine two.", "line one.\nLine two.",
                          "Line one.\nLine two"):
            with self.subTest(text=different):
                self.assertNotEqual(_digest(base, text=different), _digest(base))

    def test_override_ordering_does_not_change_the_name(self) -> None:
        line = GOLDEN_MANIFEST["cloned-voice-pcm"]
        reordered = {"noise_clamp": 1.5, "temp": 0.9}
        self.assertEqual(_digest(line, overrides=reordered), _digest(line))


class DigestParsingTests(unittest.TestCase):
    def test_accepts_both_spellings(self) -> None:
        bare = "a" * 64
        self.assertEqual(buildstore.parse_digest(bare), bare)
        self.assertEqual(buildstore.parse_digest(f"sha256:{bare.upper()}"), bare)

    def test_rejects_anything_that_could_touch_the_filesystem(self) -> None:
        for bad in ("", "..", "../../etc/passwd", "sha256:../x", "zz" * 32,
                    "a" * 63, "a" * 65, "sha256:"):
            with self.subTest(value=bad):
                with self.assertRaises(ValueError):
                    buildstore.parse_digest(bad)

    def test_if_none_match_shapes(self) -> None:
        digest = GOLDEN_DIGESTS["plain-wav"]
        bare = digest.split(":")[1]
        for header in (digest, f'"{digest}"', f'W/"{digest}"', bare,
                       f'"nope", "{digest}"', "*"):
            with self.subTest(header=header):
                self.assertTrue(buildstore.etag_matches(header, digest))
        for header in (None, "", '"deadbeef"', "sha256:" + "b" * 64):
            with self.subTest(header=header):
                self.assertFalse(buildstore.etag_matches(header, digest))


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.store = buildstore.BuildStore(root=self.root, max_bytes=4096)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _digest(self, n: int) -> str:
        return "sha256:" + f"{n:064x}"

    def test_round_trip_with_metadata(self) -> None:
        d = self._digest(1)
        self.assertFalse(self.store.has(d))
        self.assertTrue(self.store.put(d, b"RIFFDATA", content_type="audio/wav",
                                       audio_seconds=1.25, sample_rate=24000))
        self.assertTrue(self.store.has(d))
        entry = self.store.get(d)
        self.assertEqual(entry.data, b"RIFFDATA")
        self.assertEqual(entry.content_type, "audio/wav")
        self.assertEqual(entry.audio_seconds, 1.25)
        self.assertEqual(entry.sample_rate, 24000)
        head = self.store.head(d)
        self.assertEqual(head.data, b"")
        self.assertEqual(head.content_type, "audio/wav")

    def test_sharded_layout_and_no_stray_temp_files(self) -> None:
        d = self._digest(0xAB)
        self.store.put(d, b"x" * 16, content_type="audio/wav")
        bare = buildstore.parse_digest(d)
        self.assertTrue((self.root / bare[:2] / f"{bare}.bin").is_file())
        self.assertTrue((self.root / bare[:2] / f"{bare}.json").is_file())
        self.assertEqual([p.name for p in self.root.rglob("*.tmp")], [])
        meta = json.loads((self.root / bare[:2] / f"{bare}.json").read_text())
        self.assertEqual(meta["identity_version"], buildstore.IDENTITY_VERSION)

    def test_absent_and_malformed_digests_are_not_errors(self) -> None:
        self.assertIsNone(self.store.get(self._digest(9)))
        self.assertFalse(self.store.has("../../etc/passwd"))

    def test_an_artifact_larger_than_the_budget_is_refused(self) -> None:
        d = self._digest(2)
        self.assertFalse(self.store.put(d, b"x" * 5000, content_type="audio/wav"))
        self.assertFalse(self.store.has(d))

    def test_disabled_store_stores_nothing(self) -> None:
        store = buildstore.BuildStore(root=self.root, max_bytes=0)
        self.assertFalse(store.enabled)
        self.assertFalse(store.put(self._digest(3), b"x", content_type="audio/wav"))

    def test_lru_prune_keeps_the_recently_USED_not_the_recently_written(self) -> None:
        store = buildstore.BuildStore(root=self.root, max_bytes=2500)
        first, second, third = self._digest(11), self._digest(12), self._digest(13)
        for d in (first, second):
            store.put(d, b"x" * 1000, content_type="audio/wav")
            time.sleep(0.01)
        # Touch the OLDEST by reading it: recency of use, not of write.
        store.get(first)
        time.sleep(0.01)
        store.put(third, b"x" * 1000, content_type="audio/wav")
        self.assertTrue(store.has(first))
        self.assertTrue(store.has(third))
        self.assertFalse(store.has(second), "least recently USED must go first")
        self.assertLessEqual(store.total_bytes(), 2500)
        # The sidecar goes with its payload — no orphan metadata.
        bare = buildstore.parse_digest(second)
        self.assertFalse((self.root / bare[:2] / f"{bare}.json").exists())

    def test_named_budget_is_read_from_the_environment(self) -> None:
        prior = os.environ.get("GRAVITONE_BUILD_STORE_BYTES")
        os.environ["GRAVITONE_BUILD_STORE_BYTES"] = "1234"
        try:
            self.assertEqual(buildstore.store_max_bytes(), 1234)
            os.environ["GRAVITONE_BUILD_STORE_BYTES"] = "not-a-number"
            self.assertEqual(buildstore.store_max_bytes(),
                             buildstore.STORE_MAX_BYTES_DEFAULT)
        finally:
            if prior is None:
                os.environ.pop("GRAVITONE_BUILD_STORE_BYTES", None)
            else:
                os.environ["GRAVITONE_BUILD_STORE_BYTES"] = prior


class _RouteCase(unittest.TestCase):
    """A fake engine plus a throwaway store wired into the app."""

    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_store = appmod.BUILD_STORE
        appmod.SYNTH_CACHE.clear()
        self._tmp = tempfile.TemporaryDirectory()
        appmod.BUILD_STORE = buildstore.BuildStore(root=Path(self._tmp.name),
                                                   max_bytes=8 * 1024 * 1024)
        self.engine = fake_engine.FakeEngine(workers=1, delay=0.01)
        appmod.ENGINE = self.engine
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        appmod.ENGINE = self._orig_engine
        appmod.BUILD_STORE = self._orig_store
        self.engine.close()
        self._tmp.cleanup()

    def _tts(self, text: str = "Hello world.", **kw):
        params = {"output_format": kw.pop("output_format", "wav_24000")}
        headers = kw.pop("headers", None)
        return self.client.post(f"/v1/text-to-speech/{kw.pop('voice', 'alba')}",
                                params=params, headers=headers,
                                json={"text": text, **kw})


class DigestHeaderTests(_RouteCase):
    def test_response_carries_the_digest_and_a_matching_etag(self) -> None:
        r = self._tts()
        self.assertEqual(r.status_code, 200)
        digest = r.headers["x-speech-digest"]
        self.assertTrue(digest.startswith("sha256:"))
        self.assertEqual(r.headers["etag"], f'"{digest}"')

    def test_if_none_match_answers_304_without_synthesizing(self) -> None:
        first = self._tts()
        digest = first.headers["x-speech-digest"]
        before = len(self.engine.jobs)
        again = self._tts(headers={"If-None-Match": f'"{digest}"'})
        self.assertEqual(again.status_code, 304)
        self.assertEqual(again.headers["x-speech-digest"], digest)
        self.assertEqual(again.content, b"")
        self.assertEqual(len(self.engine.jobs), before,
                         "a 304 must not reach the worker pool at all")

    def test_a_different_digest_still_renders(self) -> None:
        stale = "sha256:" + "b" * 64
        r = self._tts(headers={"If-None-Match": f'"{stale}"'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content[:4], b"RIFF")

    def test_format_changes_the_digest(self) -> None:
        wav = self._tts(output_format="wav_24000").headers["x-speech-digest"]
        pcm = self._tts(output_format="pcm_24000").headers["x-speech-digest"]
        self.assertNotEqual(wav, pcm)

    def test_bypass_does_not_publish_an_artifact(self) -> None:
        r = self._tts(headers={"X-Gravitone-Cache": "bypass"})
        self.assertEqual(r.headers["x-cache"], "bypass")
        self.assertFalse(appmod.BUILD_STORE.has(r.headers["x-speech-digest"]))


class AudioFetchTests(_RouteCase):
    def test_a_rendered_clip_is_fetchable_by_its_digest(self) -> None:
        r = self._tts()
        digest = r.headers["x-speech-digest"]
        got = self.client.get(f"/v1/audio/{digest}")
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.content, r.content)
        self.assertEqual(got.headers["content-type"], "audio/wav")
        self.assertEqual(got.headers["x-speech-digest"], digest)

    def test_head_answers_existence_without_the_bytes(self) -> None:
        digest = self._tts().headers["x-speech-digest"]
        head = self.client.head(f"/v1/audio/{digest}")
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")
        self.assertEqual(int(head.headers["content-length"]),
                         appmod.BUILD_STORE.size_of(digest))

    def test_absent_digest_is_a_named_404(self) -> None:
        miss = self.client.get("/v1/audio/sha256:" + "c" * 64)
        self.assertEqual(miss.status_code, 404)
        self.assertEqual(miss.json()["detail"], buildstore.AUDIO_NOT_FOUND)

    def test_malformed_digest_is_a_400_and_never_a_path(self) -> None:
        bad = self.client.get("/v1/audio/not-a-digest")
        self.assertEqual(bad.status_code, 400)
        self.assertIn("sha256", bad.json()["detail"])


class BuildRouteTests(_RouteCase):
    _MANIFEST = {"lines": [
        {"id": "l1", "voice": "alba", "text": "Hello world."},
        {"id": "l2", "voice": "alba", "text": "Second line."},
    ]}

    def test_plan_reports_what_would_change_without_rendering(self) -> None:
        r = self.client.post("/v1/build/plan", json=self._MANIFEST)
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["would_render"], 2)
        self.assertEqual(body["fresh"], 0)
        self.assertEqual([l["state"] for l in body["lines"]],
                         ["would_render", "would_render"])
        self.assertEqual(len(self.engine.jobs), 0, "a plan is a dry run")

    def test_build_renders_then_the_same_build_is_fresh(self) -> None:
        first = self.client.post("/v1/build", json=self._MANIFEST).json()
        self.assertEqual(first["rendered"], 2)
        self.assertEqual(first["fresh"], 0)
        # No audio bytes anywhere in the response — a build's product is names.
        self.assertNotIn("audio_base64", json.dumps(first))
        allowed = {"id", "digest", "format", "state", "bytes", "audio_seconds"}
        for line in first["lines"]:
            self.assertLessEqual(set(line), allowed)
        for line in first["lines"]:
            self.assertTrue(appmod.BUILD_STORE.has(line["digest"]))

        jobs = len(self.engine.jobs)
        second = self.client.post("/v1/build", json=self._MANIFEST).json()
        self.assertEqual(second["fresh"], 2)
        self.assertEqual(second["rendered"], 0)
        self.assertEqual(len(self.engine.jobs), jobs,
                         "an unchanged manifest must synthesize nothing")
        self.assertEqual([l["digest"] for l in second["lines"]],
                         [l["digest"] for l in first["lines"]])

        plan = self.client.post("/v1/build/plan", json=self._MANIFEST).json()
        self.assertEqual(plan["fresh"], 2)

    def test_an_edited_line_is_the_only_one_re_rendered(self) -> None:
        self.client.post("/v1/build", json=self._MANIFEST)
        edited = {"lines": [dict(self._MANIFEST["lines"][0]),
                            {"id": "l2", "voice": "alba", "text": "Edited line."}]}
        plan = self.client.post("/v1/build/plan", json=edited).json()
        self.assertEqual([l["state"] for l in plan["lines"]],
                         ["fresh", "would_render"])
        jobs = len(self.engine.jobs)
        built = self.client.post("/v1/build", json=edited).json()
        self.assertEqual((built["fresh"], built["rendered"]), (1, 1))
        self.assertEqual(len(self.engine.jobs) - jobs, 1)

    def test_duplicate_lines_share_one_render(self) -> None:
        dup = {"lines": [{"id": "a", "voice": "alba", "text": "Same words."},
                         {"id": "b", "voice": "alba", "text": "Same words."}]}
        body = self.client.post("/v1/build", json=dup).json()
        self.assertEqual(body["lines"][0]["digest"], body["lines"][1]["digest"])
        self.assertEqual((body["rendered"], body["fresh"]), (1, 1))

    def test_unknown_voice_fails_the_manifest_naming_the_line(self) -> None:
        r = self.client.post("/v1/build", json={"lines": [
            {"id": "ok", "voice": "alba", "text": "Fine."},
            {"id": "bad", "voice": "no-such-voice-xyz", "text": "Nope."}]})
        self.assertEqual(r.status_code, 404)
        self.assertIn("line 1", r.json()["detail"])
        self.assertIn("bad", r.json()["detail"])

    def test_unsupported_format_400s_before_any_synthesis(self) -> None:
        r = self.client.post("/v1/build", json={"lines": [
            {"id": "l1", "voice": "alba", "text": "Hi.", "format": "ogg_24000"}]})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(len(self.engine.jobs), 0)

    def test_manifest_size_is_capped(self) -> None:
        lines = [{"id": str(i), "voice": "alba", "text": "Hi."}
                 for i in range(buildstore.BUILD_MANIFEST_MAX_LINES + 1)]
        r = self.client.post("/v1/build", json={"lines": lines})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(len(self.engine.jobs), 0)

    def test_backpressure_is_the_ordinary_429(self) -> None:
        self.engine.close()
        self.engine = fake_engine.FakeEngine(workers=1, delay=0.01, capacity=0)
        appmod.ENGINE = self.engine
        r = self.client.post("/v1/build", json=self._MANIFEST)
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.headers["Retry-After"], "1")


class OneIdentityTests(_RouteCase):
    """The whole point: a plain call and a build line are the same artifact."""

    def test_tts_and_build_agree_on_the_digest(self) -> None:
        wav = self._tts("A shared line.")
        built = self.client.post("/v1/build", json={"lines": [
            {"id": "l1", "voice": "alba", "text": "A shared line.",
             "format": "wav_24000"}]}).json()
        self.assertEqual(built["lines"][0]["digest"],
                         wav.headers["x-speech-digest"])
        self.assertEqual(built["lines"][0]["state"], "fresh",
                         "the plain call already published this artifact")

    def test_a_build_artifact_serves_the_plain_route_a_304(self) -> None:
        built = self.client.post("/v1/build", json={"lines": [
            {"id": "l1", "voice": "alba", "text": "Built first."}]}).json()
        digest = built["lines"][0]["digest"]
        jobs = len(self.engine.jobs)
        r = self._tts("Built first.", headers={"If-None-Match": digest})
        self.assertEqual(r.status_code, 304)
        self.assertEqual(len(self.engine.jobs), jobs)

    def test_settings_that_change_the_audio_change_the_digest(self) -> None:
        plain = self._tts("Knobs.").headers["x-speech-digest"]
        warm = self._tts("Knobs.", voice_settings={"temperature": 0.9})
        self.assertNotEqual(warm.headers["x-speech-digest"], plain)
        # ...and the inert ElevenLabs settings do NOT: they cannot reach the
        # model, so they cannot name different audio.
        inert = self._tts("Knobs.", voice_settings={"style": 0.4})
        self.assertEqual(inert.headers["x-speech-digest"], plain)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
