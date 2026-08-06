"""Honest limits at the door: the verdict lands before the media does.

The caps (50 MB, `MAX_CLIP_SECONDS`) were sized for a clip a user chose to
upload, and the studio's browser-side duration pre-check cannot run on a URL.
Without a metadata probe, a two-hour podcast is refused only AFTER the wait —
the single worst failure this feature could have.

So: `POST /v1/ingest/link/probe` answers from metadata alone, and the same
verdict is re-taken (never believed from the client) inside `scan-url`. A long
video is TRIMMED rather than rejected — a 47-minute interview is a perfectly
good source for one voice and the user cannot edit a link — and the cut is
stated at paste time, never applied silently.

No network, no yt-dlp, no ffmpeg: `_run` / `_popen` are the seam.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # noqa: F401 - installs shims before app import

import service.app as appmod
import service.ingest_api as ingest_api
import service.ingest_url as ingest_url
import service.ratelimit as ratelimit
from fastapi.testclient import TestClient

from service.tests.test_ingest_link import URL, _FakeProc, _FakeRun, _public_dns


def _info(duration: float | None, **extra) -> ingest_url.LinkInfo:
    return ingest_url.LinkInfo(title="A talk", duration=duration,
                               uploader="Someone", is_live=False, **extra)


class VerdictTests(unittest.TestCase):
    def _verdict(self, duration: float | None):
        return ingest_url.verdict(_info(duration), min_seconds=3.0, max_seconds=900.0)

    def test_a_clip_that_fits_says_nothing_will_be_cut(self) -> None:
        v = self._verdict(240.0)
        self.assertTrue(v.ok)
        self.assertFalse(v.trimmed)
        self.assertEqual(v.clip_seconds, 240.0)
        self.assertIn("nothing will be cut", v.message)

    def test_a_long_video_is_trimmed_and_the_cut_is_stated(self) -> None:
        v = self._verdict(47 * 60)
        self.assertTrue(v.ok, "a long video is usable, not refused")
        self.assertTrue(v.trimmed)
        self.assertEqual(v.clip_seconds, 900.0)
        self.assertIn("47 minutes", v.message)
        self.assertIn("first 15 minutes", v.message)

    def test_a_video_too_short_is_refused_not_padded(self) -> None:
        v = self._verdict(2.0)
        self.assertFalse(v.ok)
        self.assertIn("at least", v.message)

    def test_an_unreadable_length_is_a_refusal_that_names_the_fallback(self) -> None:
        v = self._verdict(None)
        self.assertFalse(v.ok)
        self.assertIn("drop", v.message.lower())


class ProbeTests(unittest.TestCase):
    def test_the_probe_transfers_no_media(self) -> None:
        seen: list = []

        def run(cmd, **kwargs):
            seen.append(cmd)
            return _FakeRun(duration=300.0)(cmd)

        with mock.patch.object(ingest_url, "_run", run):
            info = ingest_url.probe(URL)
        self.assertIn("--skip-download", seen[0])
        self.assertIn("-J", seen[0])
        self.assertEqual(info.duration, 300.0)
        self.assertEqual(info.title, "A talk")

    def test_a_playlist_is_named_not_half_handled(self) -> None:
        payload = json.dumps({"_type": "playlist", "entries": []}).encode()
        with mock.patch.object(ingest_url, "_run",
                               lambda cmd, **kw: mock.Mock(returncode=0,
                                                           stdout=payload,
                                                           stderr=b"")):
            with self.assertRaises(ingest_url.LinkRefusal) as ctx:
                ingest_url.probe(URL)
        self.assertIn("playlist", ctx.exception.message)

    def test_a_live_stream_is_refused(self) -> None:
        with mock.patch.object(ingest_url, "_run",
                               _FakeRun(duration=None, is_live=True)):
            with self.assertRaises(ingest_url.LinkRefusal) as ctx:
                ingest_url.probe(URL)
        self.assertIn("live", ctx.exception.message)

    def test_a_failed_probe_carries_no_extractor_output(self) -> None:
        with mock.patch.object(ingest_url, "_run",
                               lambda cmd, **kw: mock.Mock(
                                   returncode=1, stdout=b"",
                                   stderr=b"ERROR: /home/op/cookies.txt is unreadable")):
            with self.assertRaises(ingest_url.LinkRefusal) as ctx:
                ingest_url.probe(URL)
        self.assertNotIn("cookies.txt", ctx.exception.message)
        self.assertIn("drop", ctx.exception.message.lower())


class ProbeRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def _probe(self, url: str = URL):
        return self.client.post("/v1/ingest/link/probe", json={"url": url})

    def test_it_answers_the_verdict_before_anything_is_fetched(self) -> None:
        with mock.patch("socket.getaddrinfo", _public_dns), \
             mock.patch.object(ingest_url, "_run", _FakeRun(duration=47 * 60)), \
             mock.patch.object(ingest_url, "_popen",
                               side_effect=AssertionError("fetched!")):
            r = self._probe()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["ok"])
        self.assertTrue(body["trimmed"])
        self.assertEqual(body["clip_seconds"], ingest_api.MAX_CLIP_SECONDS)
        self.assertIn("first 15 minutes", body["message"])
        # The studio must not invent the sentence the commit will demand.
        self.assertEqual(body["attestation"], ingest_url.EXTERNAL_STATEMENT)

    def test_it_applies_the_same_url_validation_as_the_scan(self) -> None:
        r = self._probe("https://files.evil.example/clip.mp3")
        self.assertEqual(r.status_code, 403)
        self.assertIn("drop", r.json()["detail"].lower())

    def test_an_unreadable_link_is_a_named_refusal_with_the_fallback(self) -> None:
        with mock.patch("socket.getaddrinfo", _public_dns), \
             mock.patch.object(ingest_url, "_run",
                               lambda cmd, **kw: mock.Mock(
                                   returncode=1, stdout=b"",
                                   stderr=b"ERROR: Video unavailable")):
            r = self._probe()
        self.assertEqual(r.status_code, 422)
        self.assertIn("unavailable", r.json()["detail"])
        self.assertIn("drop", r.json()["detail"].lower())

    def test_it_carries_its_own_budget_and_a_429_states_when_to_return(self) -> None:
        # VERIFIED rather than assumed: a 429 with no Retry-After makes the
        # client invent the wait, and the studio counts down on this header.
        self.assertIn("ingest-link", ratelimit.BUDGETS)
        limiter = ratelimit.BUDGETS["ingest-link"]
        decision = None
        with mock.patch.dict("os.environ", {"GRAVITONE_RATELIMIT_TEST_BYPASS": "0"}):
            for _ in range(limiter.limit + limiter.burst + 2):
                r = self._probe("https://youtu.be/abc")
                if r.status_code == 429:
                    decision = r
                    break
        self.assertIsNotNone(decision, "the probe budget must eventually refuse")
        self.assertTrue(decision.headers.get("Retry-After"),
                        "a 429 must say when to come back")
        limiter.reset()

    def test_the_probe_route_stays_off_the_event_loop(self) -> None:
        import inspect
        self.assertFalse(inspect.iscoroutinefunction(ingest_api.probe_link),
                         "the probe shells out to the extractor")


class TrimEnforcementTests(unittest.TestCase):
    """The trim is a fact about the file, not a hope about a flag."""

    def test_the_download_asks_for_only_the_head_when_trimming(self) -> None:
        cmd = ingest_url.build_download_cmd(URL, Path("/tmp/x"), max_bytes=99,
                                            trim_seconds=895)
        self.assertIn("--download-sections", cmd)
        self.assertEqual(cmd[cmd.index("--download-sections") + 1], "*0-895")

    def test_no_section_is_requested_when_the_video_already_fits(self) -> None:
        cmd = ingest_url.build_download_cmd(URL, Path("/tmp/x"), max_bytes=99)
        self.assertNotIn("--download-sections", cmd)

    def test_a_file_delivered_over_the_cap_is_cut_locally(self) -> None:
        plan = ingest_url.Verdict(True, "A talk", 47 * 60, 900.0, True, "")
        with TemporaryDirectory() as td:
            src = Path(td) / "link-src.webm"
            src.write_bytes(b"OggS")
            cut = Path(td) / "link-src-trimmed.webm"
            with mock.patch.object(ingest_api, "probe_duration",
                                   side_effect=[2000.0, 890.0]), \
                 mock.patch.object(ingest_url, "trim_to",
                                   return_value=cut) as trim:
                out = ingest_api._enforce_trim(src, plan)
        trim.assert_called_once()
        self.assertEqual(out, cut)

    def test_a_file_that_honoured_the_section_is_left_alone(self) -> None:
        plan = ingest_url.Verdict(True, "A talk", 47 * 60, 900.0, True, "")
        with TemporaryDirectory() as td:
            src = Path(td) / "link-src.webm"
            src.write_bytes(b"OggS")
            with mock.patch.object(ingest_api, "probe_duration", return_value=880.0), \
                 mock.patch.object(ingest_url, "trim_to",
                                   side_effect=AssertionError("cut anyway!")):
                self.assertEqual(ingest_api._enforce_trim(src, plan), src)

    def test_audio_that_cannot_be_cut_never_reaches_analyze(self) -> None:
        plan = ingest_url.Verdict(True, "A talk", 47 * 60, 900.0, True, "")
        with TemporaryDirectory() as td:
            src = Path(td) / "link-src.webm"
            src.write_bytes(b"OggS")
            with mock.patch.object(ingest_api, "probe_duration",
                                   side_effect=[2000.0, 1900.0]), \
                 mock.patch.object(ingest_url, "trim_to", return_value=src):
                with self.assertRaises(ingest_url.LinkRefusal):
                    ingest_api._enforce_trim(src, plan)

    def test_the_trim_target_lands_under_the_ceiling_not_on_it(self) -> None:
        self.assertLess(ingest_api.TRIM_TARGET_SECONDS, ingest_api.MAX_CLIP_SECONDS)

    def test_trim_to_prefers_a_stream_copy_over_a_re_encode(self) -> None:
        with TemporaryDirectory() as td:
            src = Path(td) / "link-src.m4a"
            src.write_bytes(b"ftypM4A ")
            calls: list = []

            def run(cmd, **kwargs):
                calls.append(cmd)
                Path(cmd[-1]).write_bytes(b"cut")
                return mock.Mock(returncode=0, stdout=b"", stderr=b"")

            with mock.patch.object(ingest_url, "_run", run):
                out = ingest_url.trim_to(src, 895)
            self.assertEqual(len(calls), 1, "a copy cut that worked must not re-encode")
            self.assertIn("-c", calls[0])
            self.assertIn("copy", calls[0])
            self.assertEqual(calls[0][0], "ffmpeg",
                             "the ffmpeg already required, not a new decoder")
            self.assertTrue(out.exists())
            self.assertFalse(src.exists(), "the untrimmed source must not survive")


class ScanUrlTrimTests(unittest.TestCase):
    """The whole route, from a 47-minute link to a 15-minute job."""

    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self._work = ingest_api.WORK_ROOT
        ingest_api.WORK_ROOT = Path(self._dir.name) / "work"
        ingest_api.WORK_ROOT.mkdir(parents=True)
        self.client = TestClient(appmod.app, raise_server_exceptions=False)
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self) -> None:
        ingest_api.WORK_ROOT = self._work
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)
        self._dir.cleanup()

    def test_a_long_link_is_trimmed_and_the_job_says_so(self) -> None:
        cmds: list = []

        def popen(cmd, stdout=None, stderr=None):
            cmds.append(cmd)
            return _FakeProc(Path(cmd[cmd.index("-o") + 1]).parent)(cmd, stdout, stderr)

        with mock.patch("socket.getaddrinfo", _public_dns), \
             mock.patch.object(ingest_url, "_run", _FakeRun(duration=47 * 60)), \
             mock.patch.object(ingest_url, "_popen", popen), \
             mock.patch.object(ingest_api, "probe_duration", return_value=880.0), \
             mock.patch.object(ingest_api, "_spawn"):
            r = self.client.post("/v1/ingest/scan-url", json={"url": URL})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("--download-sections", cmds[0],
                      "only the head of a long video is transferred")
        source = ingest_api.JOBS[r.json()["job_id"]]["source"]
        self.assertTrue(source["trimmed"])
        self.assertEqual(source["clip_seconds"], ingest_api.MAX_CLIP_SECONDS)
        self.assertEqual(source["title"], "A talk")

    def test_the_verdict_is_re_taken_here_not_believed_from_the_client(self) -> None:
        # A client that never probed (or probed a different link) gets the same
        # answer: over-cap audio must not reach analyze on anyone's say-so.
        with mock.patch("socket.getaddrinfo", _public_dns), \
             mock.patch.object(ingest_url, "_run", _FakeRun(duration=1.0)), \
             mock.patch.object(ingest_url, "_popen",
                               side_effect=AssertionError("fetched!")), \
             mock.patch.object(ingest_api, "_spawn"):
            r = self.client.post("/v1/ingest/scan-url", json={"url": URL})
        self.assertEqual(r.status_code, 400)
        self.assertIn("at least", r.json()["detail"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
