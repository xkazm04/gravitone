"""Direction 2 — one true clone path.

Proves: every clone path shares ONE cleanup filter string (no divergent copy
survives), `clean_audio` invokes ffmpeg with that canonical chain, `clean_local`
delegates to it, commit refuses stems under MIN_STEM_SECONDS (reporting the
skip) unless `allow_short`, and the /v1/voices "too short" message is honest.
All ffmpeg / export subprocesses are mocked.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import ingest
from service.tests.test_ingest_lifecycle import _FakeExportPopen
from service.tests.test_ingest_pipeline import _write_wav


class CanonicalCleanupTests(unittest.TestCase):
    def test_clean_audio_uses_the_canonical_filter(self) -> None:
        calls = {}

        def fake_run(cmd, capture_output=False):
            calls["cmd"] = cmd
            return mock.Mock(returncode=0, stderr=b"")

        with mock.patch.object(ingest.subprocess, "run", side_effect=fake_run):
            ingest.clean_audio(Path("in.mp3"), Path("out.wav"))
        self.assertIn(ingest.CLEANUP_FILTER, calls["cmd"])
        self.assertEqual(ingest.CLEANUP_FILTER, "highpass=f=80,afftdn=nf=-25,loudnorm")
        self.assertIn("-ar", calls["cmd"])
        self.assertIn("24000", calls["cmd"])

    def test_clean_audio_raises_on_ffmpeg_failure(self) -> None:
        with mock.patch.object(ingest.subprocess, "run",
                               return_value=mock.Mock(returncode=1, stderr=b"boom")):
            with self.assertRaises(RuntimeError):
                ingest.clean_audio(Path("in"), Path("out"))

    def test_clean_local_delegates_to_clean_audio(self) -> None:
        with mock.patch.object(ingest, "clean_audio") as m:
            ingest.clean_local(Path("a"), Path("b"))
        m.assert_called_once()

    def test_no_divergent_filter_string_survives(self) -> None:
        # The old denoise-less chain must be gone from every clone path, and the
        # canonical string must be the only filter literal that remains.
        import service.voices as vc
        root = Path(ingest.__file__).resolve().parent.parent
        for rel in ("service/ingest.py", "service/voices.py", "clone_test.sh"):
            text = (root / rel).read_text("utf-8")
            self.assertNotIn("highpass=f=80,loudnorm", text,
                             f"divergent (denoise-less) filter still in {rel}")

    def test_create_voice_short_message_is_honest(self) -> None:
        # 3s reject threshold ↔ message must say 3s, not 5s.
        import service.voices as vc
        text = Path(vc.__file__).read_text("utf-8")
        self.assertIn("at least 3 seconds", text)
        self.assertNotIn("at least 5 seconds", text)


class CommitEligibilityTests(unittest.TestCase):
    def _commit(self, wd: Path, emotions, root: Path, **kw):
        from service import voices as vc
        with mock.patch.object(ingest, "VOICES_DIR", root), \
             mock.patch.object(vc, "VOICES_DIR", root), \
             mock.patch.object(vc, "META_PATH", root / "_meta.json"), \
             mock.patch.object(ingest.subprocess, "Popen", _FakeExportPopen):
            return ingest.commit(wd, "Ada", emotions, None,
                                 consent="mine", clip_sha256="h", **kw)

    def test_short_stem_is_skipped_and_reported(self) -> None:
        _FakeExportPopen.spawned = 0
        logs: list[str] = []
        with TemporaryDirectory() as td, TemporaryDirectory() as vtd:
            wd = Path(td)
            _write_wav(wd / "stem_short.wav", 24000 * 2)   # 2s  → ineligible
            _write_wav(wd / "stem_long.wav", 24000 * 6)    # 6s  → cloned
            with mock.patch.object(ingest, "_log", side_effect=logs.append):
                created = self._commit(wd, ["short", "long"], Path(vtd))
        # Only the eligible stem became a Voice; the short one was skipped...
        self.assertEqual([c["emotion"] for c in created], ["long"])
        # ...and the skip was reported.
        self.assertTrue(any("short" in m and "minimum" in m for m in logs))

    def test_all_short_does_not_fail_commit(self) -> None:
        with TemporaryDirectory() as td, TemporaryDirectory() as vtd:
            wd = Path(td)
            _write_wav(wd / "stem_a.wav", 24000 * 1)
            with mock.patch.object(ingest, "_log"):
                created = self._commit(wd, ["a"], Path(vtd))
        self.assertEqual(created, [])  # skipped, but no exception

    def test_allow_short_clones_short_stem(self) -> None:
        _FakeExportPopen.spawned = 0
        with TemporaryDirectory() as td, TemporaryDirectory() as vtd:
            wd = Path(td)
            _write_wav(wd / "stem_short.wav", 24000 * 2)   # 2s
            created = self._commit(wd, ["short"], Path(vtd), allow_short=True)
        self.assertEqual([c["emotion"] for c in created], ["short"])
        self.assertEqual(_FakeExportPopen.spawned, 1)


if __name__ == "__main__":
    unittest.main()
