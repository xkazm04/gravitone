"""Direction 1 — parallel labeling + one-load commit.

Proves (all subprocess / model calls mocked — no ffmpeg, no network, no torch):
  * labeling runs segments CONCURRENTLY (a fake classifier measures overlap),
    results stay ORDER-STABLE, and one segment's failure degrades ONLY that
    segment to baseline while the batch completes;
  * commit clones N stems with EXACTLY ONE child process (one model load), and a
    cancel between emotions terminates that child after the current line;
  * service.export_stems loads the model once and exports every stem in a loop.
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import threading
import time
import types
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import export_stems, ingest
from service.emotions import BASELINE


def _write_wav(path: Path, frames: int = 24000) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * frames)


def _seg(i: int) -> dict:
    return {"speaker": "speaker_0", "start": float(i), "end": float(i) + 1.0,
            "text": f"line {i}"}


class ParallelLabelingTests(unittest.TestCase):
    def _setup_work(self, td: str, n: int) -> Path:
        wd = Path(td)
        _write_wav(wd / "clean.wav")
        (wd / "segments.json").write_text(json.dumps([_seg(i) for i in range(n)]), "utf-8")
        return wd

    def test_segments_labelled_concurrently(self) -> None:
        n = 8
        cur = {"n": 0, "max": 0}
        lock = threading.Lock()

        def fake_label(wav_path):
            with lock:
                cur["n"] += 1
                cur["max"] = max(cur["max"], cur["n"])
            time.sleep(0.05)
            with lock:
                cur["n"] -= 1
            return {"emotion": "happy", "confidence": 0.9, "cue": "c", "model": "flash"}

        with TemporaryDirectory() as td:
            wd = self._setup_work(td, n)
            with mock.patch.object(ingest, "to_wav", side_effect=lambda src, dst, a=None, b=None: _write_wav(Path(dst), 240)), \
                 mock.patch.object(ingest, "label_emotion", side_effect=fake_label):
                res = ingest.label_and_stem(wd, "speaker_0", mode="cloud")
        # More than one segment occupied the pool at once (serial would be 1),
        # but never more than the bounded pool.
        self.assertGreaterEqual(cur["max"], 2)
        self.assertLessEqual(cur["max"], ingest.LABEL_WORKERS)
        self.assertEqual(len(res["segments"]), n)

    def test_label_order_is_stable(self) -> None:
        n = 6
        emos = ["calm", "happy", "excited", "sad", "angry", "whisper"]

        def fake_label(wav_path):
            i = int(Path(wav_path).stem.split("_")[1])
            time.sleep(0.02 * (n - i))  # earlier indices finish LAST
            return {"emotion": emos[i], "confidence": 0.9, "cue": f"c{i}", "model": "flash"}

        with TemporaryDirectory() as td:
            wd = self._setup_work(td, n)
            with mock.patch.object(ingest, "to_wav", side_effect=lambda src, dst, a=None, b=None: _write_wav(Path(dst), 240)), \
                 mock.patch.object(ingest, "label_emotion", side_effect=fake_label):
                res = ingest.label_and_stem(wd, "speaker_0", mode="cloud")
        self.assertEqual([s["emotion"] for s in res["segments"]], emos)

    def test_single_failure_degrades_only_that_segment(self) -> None:
        n = 5
        partials: list[dict] = []

        def fake_label(wav_path):
            i = int(Path(wav_path).stem.split("_")[1])
            if i == 2:
                raise RuntimeError("gemini boom")
            return {"emotion": "happy", "confidence": 0.9, "cue": f"c{i}", "model": "flash"}

        with TemporaryDirectory() as td:
            wd = self._setup_work(td, n)
            with mock.patch.object(ingest, "to_wav", side_effect=lambda src, dst, a=None, b=None: _write_wav(Path(dst), 240)), \
                 mock.patch.object(ingest, "label_emotion", side_effect=fake_label):
                res = ingest.label_and_stem(wd, "speaker_0", mode="cloud",
                                            partial=lambda d: partials.append(d))
        segs = res["segments"]
        self.assertEqual(len(segs), n)                       # batch survived
        self.assertEqual(segs[2]["emotion"], BASELINE)       # failed → baseline
        self.assertEqual(segs[2]["model"], "error")
        for i in (0, 1, 3, 4):                               # neighbours intact
            self.assertEqual(segs[i]["emotion"], "happy")
        self.assertEqual(partials[-1]["label_errors"], 1)    # surfaced in partial
        self.assertEqual(partials[-1]["segments_done"], n)


class OneLoadCommitTests(unittest.TestCase):
    def _work(self, td: str, emotions) -> Path:
        wd = Path(td)
        for e in emotions:
            _write_wav(wd / f"stem_{e}.wav", 24000 * 6)  # 6s each
        return wd

    def test_commit_spawns_export_once_for_n_stems(self) -> None:
        from service.tests.test_ingest_lifecycle import _FakeExportPopen
        from service import voices as vc
        _FakeExportPopen.spawned = 0
        progress: list[tuple] = []
        with TemporaryDirectory() as td, TemporaryDirectory() as vtd:
            wd = self._work(td, ["happy", "sad", "angry"])
            root = Path(vtd)
            with mock.patch.object(ingest, "VOICES_DIR", root), \
                 mock.patch.object(vc, "VOICES_DIR", root), \
                 mock.patch.object(vc, "META_PATH", root / "_meta.json"), \
                 mock.patch.object(ingest.subprocess, "Popen", _FakeExportPopen):
                created = ingest.commit(wd, "Ada", ["happy", "sad", "angry"], None,
                                        consent="mine", clip_sha256="h",
                                        progress=lambda d, c: progress.append((d, c)))
        self.assertEqual(_FakeExportPopen.spawned, 1)        # ONE model load, N stems
        self.assertEqual([c["emotion"] for c in created], ["happy", "sad", "angry"])
        self.assertEqual(progress[-1], (3, None))            # per-emotion progress ran

    def test_commit_cancel_terminates_child_after_current_line(self) -> None:
        from service import voices as vc

        holder = {}

        class CancelPopen:
            def __init__(self, cmd, stdout=None, stderr=None, text=None):
                holder["proc"] = self
                self.terminated = False
                spec = json.loads(Path(cmd[-1]).read_text("utf-8"))
                self._stems = spec["stems"]
                self.stdout = self._gen()
                self.stderr = io.StringIO("")
                self.returncode = 0

            def _gen(self):
                for stem in self._stems:
                    Path(stem["dst"]).write_bytes(b"tensors")
                    yield json.dumps({"emotion": stem["emotion"], "ok": True}) + "\n"

            def wait(self, timeout=None):
                return 0

            def terminate(self):
                self.terminated = True

            def kill(self):
                self.terminated = True

        calls = {"n": 0}

        def should_cancel():
            calls["n"] += 1
            return calls["n"] >= 2  # top-of-commit check passes; cancel after 1st emotion

        with TemporaryDirectory() as td, TemporaryDirectory() as vtd:
            wd = self._work(td, ["happy", "sad"])
            root = Path(vtd)
            with mock.patch.object(ingest, "VOICES_DIR", root), \
                 mock.patch.object(vc, "VOICES_DIR", root), \
                 mock.patch.object(vc, "META_PATH", root / "_meta.json"), \
                 mock.patch.object(ingest.subprocess, "Popen", CancelPopen):
                created = ingest.commit(wd, "Ada", ["happy", "sad"], None,
                                        consent="mine", clip_sha256="h",
                                        should_cancel=should_cancel)
        self.assertEqual([c["emotion"] for c in created], ["happy"])  # stopped after 1
        self.assertTrue(holder["proc"].terminated)


class ExportStemsModuleTests(unittest.TestCase):
    def test_loads_model_once_and_exports_each(self) -> None:
        load_calls = {"n": 0}
        saved: list[str] = []

        class FakeModel:
            def get_state_for_audio_prompt(self, src, truncate=True):
                return {"src": src}

            def save_voice(self, state, dst):
                saved.append(dst)
                Path(dst).write_bytes(b"tensors")

        class FakeTTSModel:
            @staticmethod
            def load_model(language, quantize):
                load_calls["n"] += 1
                return FakeModel()

        fake_mod = types.ModuleType("pocket_tts")
        fake_mod.TTSModel = FakeTTSModel

        with TemporaryDirectory() as td:
            wd = Path(td)
            stems = []
            for e in ("happy", "sad"):
                src = wd / f"src_{e}.wav"
                _write_wav(src, 240)
                stems.append({"emotion": e, "src": str(src), "dst": str(wd / f"{e}.safetensors")})
            spec = wd / "spec.json"
            spec.write_text(json.dumps({"language": "english", "quantize": False,
                                        "stems": stems}), "utf-8")
            out = io.StringIO()
            with mock.patch.dict(sys.modules, {"pocket_tts": fake_mod}), \
                 contextlib.redirect_stdout(out):
                rc = export_stems.main([str(spec)])

        self.assertEqual(rc, 0)
        self.assertEqual(load_calls["n"], 1)                 # ONE load for both stems
        self.assertEqual(len(saved), 2)
        lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
        self.assertEqual([l["emotion"] for l in lines], ["happy", "sad"])
        self.assertTrue(all(l["ok"] for l in lines))


if __name__ == "__main__":
    unittest.main()
