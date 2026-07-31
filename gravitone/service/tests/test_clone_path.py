"""Direction 2 — one true clone path.

Both clone paths — the direct upload (POST /v1/voices) and the ingest commit —
now share BOTH halves:

  * one cleanup FILTER (round 1): no divergent filter string survives,
    `clean_audio` invokes ffmpeg with the canonical chain, `clean_local`
    delegates to it;
  * one EXPORTER (this round): `service.export_stems`, which loads the model
    once and only trusts an embedding it can LOAD BACK, falling back to the
    proven `pocket_tts export-voice` CLI. The direct clone used to spawn that
    CLI itself with no verification, so a serializer/format mismatch produced a
    voice that registered fine and failed later, at synthesis time.

Also pinned here: commit refuses stems under MIN_STEM_SECONDS (reporting the
skip) unless `allow_short`, and the /v1/voices "too short" message is honest.
All ffmpeg / export subprocesses are mocked — no model, no audio.
"""
from __future__ import annotations

import io
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi import HTTPException

from service import export_stems, ingest, voices
from service.tests.test_ingest_lifecycle import _FakeExportPopen
from service.tests.test_ingest_pipeline import _write_wav


def fake_export_child(*, ok: bool = True, error: str | None = None,
                      calls: list | None = None):
    """Stand-in for the `python -m service.export_stems` child `export_batch`
    spawns: reads the spec, writes each dst (when ok), and returns the real
    stdout protocol — one JSON status line per stem."""

    def _run(cmd, capture_output=False, timeout=None):
        spec = json.loads(Path(cmd[-1]).read_text("utf-8"))
        if calls is not None:
            # The spec lives in the caller's temp dir and is gone by the time a
            # test inspects it — record the parsed contents, not the path.
            calls.append({"cmd": cmd, "spec": spec})
        lines = []
        for stem in spec["stems"]:
            if ok:
                Path(stem["dst"]).write_bytes(b"tensors")
            lines.append(json.dumps({"emotion": stem["emotion"], "ok": ok,
                                     "error": None if ok else (error or "boom")}))
        return mock.Mock(returncode=0 if ok else 1,
                         stdout=("\n".join(lines) + "\n").encode(), stderr=b"")

    return _run


def clone_through(root: Path, *, child, character: str = "Ada",
                  emotion: str = "baseline"):
    """Run `voices.create_voice` end-to-end against `root`, with ffmpeg and the
    export child mocked. Returns the created Voice."""

    class _Upload:
        filename = "clip.wav"

        def __init__(self, data: bytes) -> None:
            self.file = io.BytesIO(data)

    def _fake_clean(src, dst, sr=24000):
        Path(dst).write_bytes(b"clean")

    with mock.patch.object(voices, "VOICES_DIR", root), \
         mock.patch.object(voices, "META_PATH", root / "_meta.json"), \
         mock.patch.object(voices, "_META_LOCK_PATH", root / "._meta.lock"), \
         mock.patch.object(ingest, "clean_audio", side_effect=_fake_clean), \
         mock.patch.object(voices, "_wav_seconds", return_value=12.0), \
         mock.patch.object(export_stems.subprocess, "run", side_effect=child):
        voices.invalidate()
        try:
            return voices.create_voice(
                file=_Upload(b"RIFFclip"), character=character, emotion=emotion,
                tags="", attested="true", statement="I own this voice")
        finally:
            voices.invalidate()


class SharedExporterTests(unittest.TestCase):
    """The direct clone runs the SAME verified exporter as the ingest commit."""

    def test_direct_clone_spawns_the_export_stems_child(self) -> None:
        calls: list = []
        with TemporaryDirectory() as td:
            root = Path(td)
            v = clone_through(root, child=fake_export_child(calls=calls))
            self.assertTrue((root / f"{v.voice_id}.safetensors").is_file())
        self.assertEqual(1, len(calls))
        cmd = calls[0]["cmd"]
        self.assertEqual([sys.executable, "-m", "service.export_stems"], cmd[:3])
        self.assertNotIn("export-voice", cmd)   # not the unverified CLI anymore

    def test_the_spec_names_the_requested_emotion_and_staged_destination(self) -> None:
        calls: list = []
        with TemporaryDirectory() as td:
            root = Path(td)
            v = clone_through(root, child=fake_export_child(calls=calls),
                              emotion="excited")
        spec = calls[0]["spec"]
        self.assertEqual(["excited"], [s["emotion"] for s in spec["stems"]])
        # Staged outside VOICES_DIR until the registry row is committed.
        self.assertEqual(f"{v.voice_id}.safetensors", Path(spec["stems"][0]["dst"]).name)
        self.assertNotEqual(root, Path(spec["stems"][0]["dst"]).parent)

    def test_voices_no_longer_spawns_export_voice_itself(self) -> None:
        text = Path(voices.__file__).read_text("utf-8")
        self.assertNotIn('"export-voice"', text)

    def test_an_embedding_that_cannot_be_loaded_back_fails_the_request(self) -> None:
        # `_export_one` reports the round-trip failure (after its CLI fallback
        # also failed); the clone must fail NOW, not at first synthesis, and
        # leave neither a registry row nor a file behind.
        child = fake_export_child(ok=False, error="round-trip load failed")
        with TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(HTTPException) as ctx:
                clone_through(root, child=child)
            self.assertEqual(500, ctx.exception.status_code)
            self.assertEqual([], list(root.glob("*.safetensors")))
            self.assertFalse((root / "_meta.json").is_file())
        # Sanitized: the caller gets a request id, never the exporter's text.
        self.assertNotIn("round-trip", ctx.exception.detail)

    def test_a_silent_child_is_a_failure_not_a_success(self) -> None:
        def _silent(cmd, capture_output=False, timeout=None):
            return mock.Mock(returncode=1, stdout=b"", stderr=b"model load failed")

        with TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(HTTPException):
                clone_through(root, child=_silent)
            self.assertEqual([], list(root.glob("*.safetensors")))


class ExporterVerificationTests(unittest.TestCase):
    """`_export_one` — the verification the direct clone now inherits."""

    class _Model:
        def __init__(self, loadback_fails: bool = False) -> None:
            self.loadback_fails = loadback_fails
            self.loaded: list[str] = []

        def get_state_for_audio_prompt(self, src, truncate=True):
            self.loaded.append(str(src))
            if self.loadback_fails and str(src).endswith(".safetensors"):
                raise RuntimeError("header too small")
            return {"src": src}

        def save_voice(self, state, dst):
            Path(dst).write_bytes(b"tensors")

    def test_a_good_export_is_load_back_verified(self) -> None:
        model = self._Model()
        with TemporaryDirectory() as td:
            dst = Path(td) / "v.safetensors"
            self.assertIsNone(export_stems._export_one(model, "src.wav", dst))
            self.assertIn(str(dst), model.loaded)   # the round-trip really ran

    def test_a_failed_load_back_falls_back_to_the_cli(self) -> None:
        model = self._Model(loadback_fails=True)
        seen: list = []

        def _cli(cmd, capture_output=False):
            seen.append(cmd)
            Path(cmd[-1]).write_bytes(b"tensors")
            return mock.Mock(returncode=0, stderr=b"")

        with TemporaryDirectory() as td:
            dst = Path(td) / "v.safetensors"
            with mock.patch.object(export_stems.subprocess, "run", side_effect=_cli):
                self.assertIsNone(export_stems._export_one(model, "src.wav", dst))
        self.assertIn("export-voice", seen[0])      # the proven path, preserved

    def test_both_routes_failing_reports_both(self) -> None:
        model = self._Model(loadback_fails=True)
        with TemporaryDirectory() as td:
            dst = Path(td) / "v.safetensors"
            with mock.patch.object(export_stems.subprocess, "run",
                                   return_value=mock.Mock(returncode=1, stderr=b"cli boom")):
                err = export_stems._export_one(model, "src.wav", dst)
        self.assertIn("header too small", err or "")
        self.assertIn("cli boom", err or "")
        self.assertFalse(dst.exists())              # never leave an unloadable file


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
