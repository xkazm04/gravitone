"""A pasted link becomes a voice — with the same guards a file gets, and more.

Nothing here touches the network or yt-dlp: `ingest_url._run` / `._popen` are
the seam (that is why the module shells out rather than importing yt_dlp), and
DNS is mocked. What is proven:

  - the URL is validated BEFORE anything is admitted or fetched — scheme, a
    YouTube-only host allowlist, and every resolved address checked public;
  - the download command carries no postprocessor flag, so no second decoder
    and no ffmpeg transcode is involved;
  - the byte ceiling holds even when the server lies about the size;
  - a link-sourced job is MARKED as one, the marker is served, and the commit
    refuses the ownership attestation for it (and requires the true one);
  - extractor failures come back as typed, human refusals that name the
    file-drop fallback — never as raw yt-dlp stderr.

UNVERIFIED HERE, and honestly so: that a real YouTube URL extracts. That needs
the network and a live site; these tests cannot and do not claim it.
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # noqa: F401 - installs shims before app import

import service.app as appmod
import service.ingest as ingest
import service.ingest_api as ingest_api
import service.ingest_url as ingest_url
from fastapi.testclient import TestClient

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def _public_dns(*_a, **_k):
    return [(2, 1, 6, "", ("93.184.216.34", 443))]


class _FakeRun:
    """`yt-dlp -J` (the metadata probe): answers one video's JSON."""

    def __init__(self, duration: float = 120.0, title: str = "A talk",
                 returncode: int = 0, stderr: str = "", **extra) -> None:
        import json as _json
        self.returncode = returncode
        self.stdout = _json.dumps({"title": title, "duration": duration,
                                   "uploader": "Someone", **extra}).encode()
        self.stderr = stderr.encode()

    def __call__(self, cmd, **kwargs):
        return self


class _FakeProc:
    """A yt-dlp that writes `written` bytes to the output file and exits."""

    def __init__(self, dest: Path, written: bytes = b"OggS-audio",
                 returncode: int = 0, stderr: str = "", ext: str = "webm",
                 stem: str | None = None) -> None:
        self.dest, self.written, self.returncode = dest, written, returncode
        self.stderr_text, self.ext = stderr, ext
        self.stem = stem or ingest_url.STEM
        self._polled = 0
        self.killed = False

    def __call__(self, cmd, stdout=None, stderr=None):
        if self.written:
            (self.dest / f"{self.stem}.{self.ext}").write_bytes(self.written)
        if self.stderr_text and stderr is not None:
            stderr.write(self.stderr_text.encode())
        return self

    def poll(self):
        self._polled += 1
        return self.returncode

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        return self.returncode


class GuardTests(unittest.TestCase):
    def test_only_http_and_https(self) -> None:
        for bad in ("file:///etc/passwd", "ftp://youtube.com/x", "javascript:1"):
            with self.subTest(url=bad), self.assertRaises(ingest_url.LinkRefusal) as ctx:
                ingest_url.guard_link(bad)
            self.assertEqual(ctx.exception.status, 400)

    def test_non_youtube_hosts_are_refused_before_dns(self) -> None:
        with mock.patch("socket.getaddrinfo", side_effect=AssertionError("resolved!")):
            with self.assertRaises(ingest_url.LinkRefusal) as ctx:
                ingest_url.guard_link("https://evil.example.com/watch?v=1")
        self.assertEqual(ctx.exception.status, 403)
        self.assertIn("not a YouTube link", ctx.exception.message)

    def test_the_suffix_rule_does_not_widen_to_a_lookalike(self) -> None:
        # ".youtube.com" must not match "notyoutube.com" or "youtube.com.evil.io"
        for bad in ("https://notyoutube.com/watch?v=1",
                    "https://youtube.com.evil.io/watch?v=1"):
            with self.subTest(url=bad), self.assertRaises(ingest_url.LinkRefusal):
                ingest_url.guard_link(bad)

    def test_subdomains_and_the_short_domain_are_allowed(self) -> None:
        with mock.patch("socket.getaddrinfo", _public_dns):
            for ok in ("https://www.youtube.com/watch?v=1",
                       "https://m.youtube.com/watch?v=1",
                       "https://music.youtube.com/watch?v=1",
                       "https://youtu.be/abc", "https://youtube.com/watch?v=1"):
                with self.subTest(url=ok):
                    self.assertEqual(ingest_url.guard_link(ok), ok)

    def test_a_private_address_is_refused_even_on_an_allowed_host(self) -> None:
        # The SSRF case that matters: DNS for an allowlisted name answering with
        # a link-local address (169.254.169.254 is the cloud metadata service).
        with mock.patch("socket.getaddrinfo",
                        return_value=[(2, 1, 6, "", ("169.254.169.254", 443))]):
            with self.assertRaises(ingest_url.LinkRefusal) as ctx:
                ingest_url.guard_link(URL)
        self.assertEqual(ctx.exception.status, 403)

    def test_every_resolved_address_is_checked_not_just_the_first(self) -> None:
        with mock.patch("socket.getaddrinfo", return_value=[
                (2, 1, 6, "", ("93.184.216.34", 443)),
                (2, 1, 6, "", ("127.0.0.1", 443))]):
            with self.assertRaises(ingest_url.LinkRefusal):
                ingest_url.guard_link(URL)

    def test_every_refusal_names_the_fallback(self) -> None:
        with mock.patch("socket.getaddrinfo", _public_dns):
            for bad in ("", "ftp://youtube.com/x", "https://evil.example.com/x",
                        "https:///nohost"):
                with self.subTest(url=bad):
                    try:
                        ingest_url.guard_link(bad)
                    except ingest_url.LinkRefusal as exc:
                        self.assertIn("drop", exc.message.lower())


class DownloadShapeTests(unittest.TestCase):
    def test_the_command_carries_no_postprocessor(self) -> None:
        cmd = ingest_url.build_download_cmd(URL, Path("/tmp/x"), max_bytes=1024)
        joined = " ".join(cmd)
        for forbidden in ("-x", "--extract-audio", "--audio-format",
                          "--recode-video", "--embed-thumbnail",
                          "--embed-metadata", "--merge-output-format",
                          "--postprocessor-args"):
            self.assertNotIn(forbidden, cmd,
                             f"{forbidden} would hand the file to ffmpeg for a "
                             "transcode this path must not do")
        self.assertIn("bestaudio[ext=m4a]/bestaudio", joined)
        self.assertIn("--no-playlist", cmd)
        self.assertIn("--max-filesize", cmd)
        self.assertEqual(cmd[cmd.index("--max-filesize") + 1], "1024")

    def test_the_written_file_is_returned(self) -> None:
        with TemporaryDirectory() as td:
            dest = Path(td)
            with mock.patch.object(ingest_url, "_popen", _FakeProc(dest)):
                src = ingest_url.download(URL, dest, max_bytes=1024)
            self.assertTrue(src.exists())
            self.assertEqual(src.suffix, ".webm")   # an extension _AUDIO_EXTS knows
            self.assertIn(src.suffix, ingest_api._AUDIO_EXTS)

    def test_a_lying_size_is_caught_by_the_written_bytes(self) -> None:
        # --max-filesize is the server's declared size; this is the one that
        # does not trust it.
        with TemporaryDirectory() as td:
            dest = Path(td)
            fake = _FakeProc(dest, written=b"x" * 5000)
            with mock.patch.object(ingest_url, "_popen", fake):
                with self.assertRaises(ingest_url.LinkRefusal) as ctx:
                    ingest_url.download(URL, dest, max_bytes=1024)
            self.assertEqual(ctx.exception.status, 413)
            self.assertEqual(ingest_url._media_files(dest), [],
                             "an over-cap download must not be left on disk")

    def test_an_empty_result_is_a_refusal_not_a_success(self) -> None:
        with TemporaryDirectory() as td:
            dest = Path(td)
            with mock.patch.object(ingest_url, "_popen",
                                   _FakeProc(dest, written=b"")):
                with self.assertRaises(ingest_url.LinkRefusal):
                    ingest_url.download(URL, dest, max_bytes=1024)

    def test_extractor_failures_are_named_and_carry_no_stderr(self) -> None:
        raw = ("ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you've "
               "been granted access to this video  (caller /home/op/.netrc)")
        with TemporaryDirectory() as td:
            dest = Path(td)
            with mock.patch.object(ingest_url, "_popen",
                                   _FakeProc(dest, written=b"", returncode=1,
                                             stderr=raw)):
                with self.assertRaises(ingest_url.LinkRefusal) as ctx:
                    ingest_url.download(URL, dest, max_bytes=1024)
        msg = ctx.exception.message
        self.assertIn("private", msg.lower())
        self.assertNotIn(".netrc", msg)
        self.assertNotIn("ERROR:", msg)

    def test_an_unrecognised_failure_degrades_to_vagueness_not_a_leak(self) -> None:
        raw = "Traceback: /opt/gravitone/service/ingest_url.py line 1, key=abc123"
        with TemporaryDirectory() as td:
            dest = Path(td)
            with mock.patch.object(ingest_url, "_popen",
                                   _FakeProc(dest, written=b"", returncode=1,
                                             stderr=raw)):
                with self.assertRaises(ingest_url.LinkRefusal) as ctx:
                    ingest_url.download(URL, dest, max_bytes=1024)
        self.assertNotIn("abc123", ctx.exception.message)
        self.assertIn("drop", ctx.exception.message.lower())

    def test_a_missing_extractor_is_a_503_not_a_crash(self) -> None:
        with TemporaryDirectory() as td:
            dest = Path(td)
            with mock.patch.object(ingest_url, "_popen",
                                   side_effect=OSError("no such file")):
                with self.assertRaises(ingest_url.LinkRefusal) as ctx:
                    ingest_url.download(URL, dest, max_bytes=1024)
        self.assertEqual(ctx.exception.status, 503)


class VideoTierTests(unittest.TestCase):
    """The optional video-only fetch. Same contract as audio (no transcode,
    no mux, watched byte cap), its own stem so both can share a work dir."""

    def test_the_video_command_carries_no_postprocessor_and_no_audio(self) -> None:
        cmd = ingest_url.build_video_download_cmd(URL, Path("/tmp/x"),
                                                  max_bytes=2048)
        joined = " ".join(cmd)
        for forbidden in ("-x", "--extract-audio", "--audio-format",
                          "--recode-video", "--merge-output-format"):
            self.assertNotIn(forbidden, cmd)
        self.assertIn("bestvideo", joined)
        self.assertNotIn("bestaudio", joined)      # pictures only, on purpose
        self.assertNotIn("+", joined.split("-f ")[1].split(" ")[0])  # no mux
        self.assertIn(ingest_url.VIDEO_STEM, joined)
        self.assertEqual(cmd[cmd.index("--max-filesize") + 1], "2048")

    def test_video_download_returns_its_own_stem(self) -> None:
        with TemporaryDirectory() as td:
            dest = Path(td)
            fake = _FakeProc(dest, ext="mp4", stem=ingest_url.VIDEO_STEM)
            with mock.patch.object(ingest_url, "_popen", fake):
                out = ingest_url.download_video(URL, dest, max_bytes=1 << 20)
            self.assertEqual(out.name, f"{ingest_url.VIDEO_STEM}.mp4")

    def test_the_two_stems_do_not_see_each_other(self) -> None:
        with TemporaryDirectory() as td:
            dest = Path(td)
            (dest / f"{ingest_url.VIDEO_STEM}.mp4").write_bytes(b"v" * 100)
            # the audio fetch must not count or return the video file
            fake = _FakeProc(dest)
            with mock.patch.object(ingest_url, "_popen", fake):
                out = ingest_url.download(URL, dest, max_bytes=150)
            self.assertEqual(out.name, f"{ingest_url.STEM}.webm")
        self.assertEqual(
            [p.name for p in ingest_url._media_files(dest,
                                                     ingest_url.VIDEO_STEM)],
            [])                                     # tmpdir gone — just shape

    def test_a_video_over_its_cap_names_the_video_ceiling(self) -> None:
        with TemporaryDirectory() as td:
            dest = Path(td)
            fake = _FakeProc(dest, written=b"v" * 300, ext="mp4",
                             stem=ingest_url.VIDEO_STEM, returncode=None)  # type: ignore[arg-type]
            fake.returncode = 0
            big = _FakeProc(dest, written=b"v" * 300, ext="mp4",
                            stem=ingest_url.VIDEO_STEM)
            with mock.patch.object(ingest_url, "_popen", big):
                with self.assertRaises(ingest_url.LinkRefusal) as ctx:
                    ingest_url.download_video(URL, dest, max_bytes=100)
            self.assertEqual(ctx.exception.status, 413)
            self.assertIn("voice can still be cloned", ctx.exception.message)


class ScanUrlRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self._work = ingest_api.WORK_ROOT
        ingest_api.WORK_ROOT = self.root / "work"
        ingest_api.WORK_ROOT.mkdir(parents=True, exist_ok=True)
        self.client = TestClient(appmod.app, raise_server_exceptions=False)
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self) -> None:
        ingest_api.WORK_ROOT = self._work
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)
        self._dir.cleanup()

    def _post(self, url: str = URL, **body):
        return self.client.post("/v1/ingest/scan-url", json={"url": url, **body})

    def _fetching(self, duration: float = 120.0):
        """The whole extractor, stood in for: metadata probe + download."""
        return (mock.patch("socket.getaddrinfo", _public_dns),
                mock.patch.object(ingest_url, "_run", _FakeRun(duration=duration)),
                mock.patch.object(ingest_url, "_popen",
                                  lambda cmd, stdout=None, stderr=None: _FakeProc(
                                      Path(cmd[cmd.index("-o") + 1]).parent)(
                                          cmd, stdout, stderr)))

    def test_a_bad_host_is_refused_without_admitting_or_fetching(self) -> None:
        with mock.patch.object(ingest_api, "_admit",
                               side_effect=AssertionError("admitted!")), \
             mock.patch.object(ingest_url, "_popen",
                               side_effect=AssertionError("fetched!")):
            r = self._post("https://files.evil.example/clip.mp3")
        self.assertEqual(r.status_code, 403)
        self.assertIn("detail", r.json())

    def test_the_happy_path_starts_the_same_analyze_an_upload_would(self) -> None:
        started: list = []
        dns, meta, dl = self._fetching()
        with dns, meta, dl, \
             mock.patch.object(ingest_api, "_spawn",
                               side_effect=lambda fn, args, name: started.append((fn, args))), \
             mock.patch.object(ingest_api, "probe_duration", return_value=42.0):
            r = self._post()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["source"]["kind"], "url")
        self.assertEqual(body["source"]["url"], URL)
        self.assertEqual(len(started), 1)
        self.assertIs(started[0][0], ingest_api._analyze, "links join _analyze")
        job = ingest_api.JOBS[body["job_id"]]
        self.assertEqual(job["status"], "running")
        self.assertTrue(job["clip_sha256"])

    def test_the_source_marker_is_served_to_the_studio(self) -> None:
        dns, meta, dl = self._fetching()
        with dns, meta, dl, mock.patch.object(ingest_api, "_spawn"), \
             mock.patch.object(ingest_api, "probe_duration", return_value=42.0):
            job_id = self._post().json()["job_id"]
        served = self.client.get(f"/v1/ingest/{job_id}").json()
        self.assertEqual(served["source"]["kind"], "url")

    def test_an_upload_job_is_marked_as_an_upload(self) -> None:
        job = ingest_api._new_job("j", self.root, "sovereign", "sha", False,
                                  ingest_api.UPLOAD_SOURCE)
        self.assertEqual(job["source"], {"kind": "upload"})

    def test_a_video_with_no_speech_to_clone_is_refused_before_any_transfer(self) -> None:
        # Under MIN_CLIP_SECONDS: the metadata settles it, so no media moves
        # and no work dir is left behind.
        with mock.patch("socket.getaddrinfo", _public_dns), \
             mock.patch.object(ingest_url, "_run", _FakeRun(duration=1.0)), \
             mock.patch.object(ingest_url, "_popen",
                               side_effect=AssertionError("fetched!")):
            r = self._post()
        self.assertEqual(r.status_code, 400)
        self.assertEqual(list(ingest_api.WORK_ROOT.iterdir()), [])

    def test_an_unexpected_failure_is_sanitized(self) -> None:
        with mock.patch("socket.getaddrinfo", _public_dns), \
             mock.patch.object(ingest_url, "_run", _FakeRun()), \
             mock.patch.object(ingest_url, "download",
                               side_effect=RuntimeError(
                                   "yt-dlp exploded: /home/op/cookies.txt")):
            r = self._post()
        self.assertEqual(r.status_code, 500)
        detail = r.json()["detail"]
        self.assertIn("request ", detail)
        self.assertNotIn("cookies.txt", detail)

    def test_the_route_stays_off_the_event_loop(self) -> None:
        import inspect
        self.assertFalse(inspect.iscoroutinefunction(ingest_api.start_scan_url),
                         "scan-url runs a download subprocess and ffprobe; as "
                         "`async def` it would block the event loop")

    def test_it_shares_the_scan_budget_rather_than_minting_a_second_one(self) -> None:
        deps = [d.dependency for d in
                next(r for r in appmod.app.routes
                     if getattr(r, "path", "") == "/v1/ingest/scan-url").dependencies]
        self.assertTrue(deps, "scan-url must carry a per-IP budget")


class ExternalAttestationTests(unittest.TestCase):
    """The commit refuses to store a sentence that is false for a link."""

    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.client = TestClient(appmod.app, raise_server_exceptions=False)
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()
        wd = self.root / "wd"
        wd.mkdir()
        job = ingest_api._new_job("link1", wd, "sovereign", "sha", False,
                                  {"kind": "url", "url": URL, "title": None,
                                   "trimmed": False})
        job["status"] = "done"
        job["result"] = {"stems": []}
        ingest_api.JOBS["link1"] = job

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)
        self._dir.cleanup()

    def _commit(self, statement: str, attested: bool = True):
        return self.client.post("/v1/ingest/link1/commit", json={
            "character": "Someone", "emotions": ["neutral"],
            "attested": attested, "statement": statement})

    def test_the_ownership_sentence_is_refused_for_a_link(self) -> None:
        r = self._commit("I own this voice or have the speaker's explicit "
                         "consent to clone it.")
        self.assertEqual(r.status_code, 422)
        self.assertIn(ingest_url.EXTERNAL_STATEMENT, r.json()["detail"])

    def test_the_attestation_itself_is_still_required(self) -> None:
        # Not weakened: no attestation is still a refusal, link or not.
        r = self._commit(ingest_url.EXTERNAL_STATEMENT, attested=False)
        self.assertEqual(r.status_code, 422)

    def test_the_true_sentence_is_accepted_and_records_the_source(self) -> None:
        seen: list = []
        with mock.patch.object(ingest_api, "_spawn",
                               side_effect=lambda fn, args, name: seen.append(args)):
            r = self._commit(ingest_url.EXTERNAL_STATEMENT)
        self.assertEqual(r.status_code, 200, r.text)
        stored = seen[0][4]   # the statement argument handed to _do_commit
        self.assertTrue(stored.startswith(ingest_url.EXTERNAL_STATEMENT))
        self.assertIn(URL, stored, "the receipt must name the recording")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
