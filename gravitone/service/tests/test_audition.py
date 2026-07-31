"""The Audition Room: candidate stems, scratch synthesis, and what a commit does
with the recipe the user picked.

Three promises are pinned here, because all three are things a user cannot verify
for themselves and all three are load-bearing for trust:

  1. **Scratch isolation.** An audition writes NOTHING into the voice roster —
     not a registry row, not a .safetensors in VOICES_DIR — and leaves nothing
     behind in the job workdir, on the success path OR on the failure path.
  2. **Recipes are deterministic.** The same job produces the same candidate
     splices, with the same segment index sets, every time. A blind A/B between
     two takes is only meaningful if "the same recipe" means the same audio.
  3. **A chosen recipe actually commits.** The stem the exporter reads is the
     splice the user auditioned, and any choice that could NOT be applied is
     named on the job rather than silently downgraded to the default.

No model, no torch, no ffmpeg: the `service.export_stems` child is stubbed at the
subprocess boundary (`test_clone_path`'s pattern) and the one test that exercises
the child's own synthesis half injects a fake `pocket_tts`.
"""
from __future__ import annotations

import contextlib
import io
import json
import math
import sys
import time
import types
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # noqa: F401 - installs shims before app import

import service.app as appmod
import service.export_stems as export_stems
import service.ingest as ingest
import service.ingest_api as ingest_api
from fastapi.testclient import TestClient

RATE = 24000


def write_wav(path: Path, seconds: float, *, loud: float = 0.35,
              quiet: float = 0.02) -> None:
    """A real 16-bit mono wav with a speech-ish level structure.

    Alternating loud/quiet 100 ms blocks, so `ingest.measure_levels` finds a
    genuine floor AND a genuine speech percentile (a constant tone makes the two
    identical and every SNR zero, which would make the "tightest" recipe
    untestable rather than merely unavailable).
    """
    block = int(0.1 * RATE)
    frames = bytearray()
    n = int(seconds * RATE)
    i = 0
    while i < n:
        amp = loud if (i // block) % 2 == 0 else quiet
        for k in range(min(block, n - i)):
            v = int(amp * 32000 * math.sin(2 * math.pi * 180 * (i + k) / RATE))
            frames += int(v & 0xFFFF).to_bytes(2, "little", signed=False)
        i += block
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))


class _Scan:
    """A finished scan on disk: segment wavs, stem wavs and the result payload
    `label_and_stem` would have produced for them."""

    def __init__(self, root: Path, segs: list[tuple[str, float, float]]) -> None:
        self.dir = root
        self.segments: list[dict] = []
        by_emotion: dict[str, list[float]] = {}
        for i, (emo, dur, conf) in enumerate(segs):
            wav = root / f"seg_{i:03d}.wav"
            # Louder = cleaner: gives the SNR ordering something to find.
            write_wav(wav, dur, loud=0.2 + 0.1 * (i % 3))
            self.segments.append({"emotion": emo, "confidence": conf, "cue": "",
                                  "dur": round(dur, 2), "text": "", "model": "test",
                                  "failure": None, "escalation": None})
            by_emotion.setdefault(emo, []).append(dur)
        self.stems: list[dict] = []
        for emo, durs in by_emotion.items():
            paths = [root / f"seg_{i:03d}.wav" for i, s in enumerate(self.segments)
                     if s["emotion"] == emo]
            sp = ingest.concat_wavs(paths, root / f"stem_{emo}.wav")
            self.stems.append({"emotion": emo, "seconds": sp.seconds,
                               "segments": sp.segments, "eligible": sp.seconds >= 4.0,
                               "cues": [], "note": None})

    def result(self) -> dict:
        return {"target": "speaker_0", "utterances": len(self.segments),
                "min_stem": 4.0, "stems": [dict(s) for s in self.stems],
                "spend": {}, "segments": [dict(s) for s in self.segments],
                "duration": 60, "speakers": ["speaker_0"], "mode": "cloud"}


# ── 2. recipes are deterministic ─────────────────────────────────────────────
class RecipeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.scan = _Scan(self.root, [
            ("happy", 3.0, 0.9),
            ("happy", 1.0, 0.4),
            ("happy", 2.0, 0.8),
            ("happy", 0.6, 0.5),
            ("sad", 5.0, 0.7),
        ])

    def tearDown(self) -> None:
        self._dir.cleanup()

    def test_offers_the_default_plus_alternatives_and_names_each(self) -> None:
        res = self.scan.result()
        plan, why = ingest_api.build_recipes(self.root, res)
        self.assertIsNone(why)
        happy = next(s for s in res["stems"] if s["emotion"] == "happy")
        ids = [r["id"] for r in happy["recipes"]]
        self.assertEqual("full", ids[0])                    # default is first
        self.assertTrue(happy["recipes"][0]["default"])
        self.assertGreaterEqual(len(ids), 2)                # a real choice exists
        self.assertLessEqual(len(ids), ingest_api.MAX_RECIPES_PER_EMOTION)
        for r in happy["recipes"]:
            self.assertTrue(r["label"] and r["how"])        # named, never a score
            self.assertGreater(r["seconds"], 0)
        # `full` reports the number the ledger already showed — not a re-splice.
        self.assertEqual(happy["seconds"], happy["recipes"][0]["seconds"])

    def test_a_lone_segment_gets_no_recipes_at_all(self) -> None:
        # Absent = invisible: one segment has exactly one splice, so offering a
        # "choice" would be theatre.
        res = self.scan.result()
        ingest_api.build_recipes(self.root, res)
        sad = next(s for s in res["stems"] if s["emotion"] == "sad")
        self.assertNotIn("recipes", sad)

    def test_index_sets_are_exact_and_stable_across_rebuilds(self) -> None:
        first, _ = ingest_api.build_recipes(self.root, self.scan.result())
        second, _ = ingest_api.build_recipes(self.root, self.scan.result())
        self.assertEqual(first, second)                      # determinism
        happy = first["happy"]
        self.assertEqual([0, 1, 2, 3], happy["full"])
        # longest: the 3.0s and 2.0s takes clear the target (min_stem, capped to
        # a share of what this emotion has), spliced back in recording order.
        self.assertEqual([0, 2], happy["longest"])
        self.assertGreaterEqual(len(happy), 2)
        self.assertTrue(all(v == sorted(v) for v in happy.values()))

    def test_a_recipe_writes_its_own_wav_and_never_touches_the_shipped_stem(self) -> None:
        stem = self.root / "stem_happy.wav"
        before = stem.read_bytes()
        plan, _ = ingest_api.build_recipes(self.root, self.scan.result())
        self.assertEqual(before, stem.read_bytes())
        for rid in plan["happy"]:
            if rid == ingest_api.RECIPE_FULL:
                continue
            self.assertTrue((self.root / f"stem_happy__{rid}.wav").is_file())

    def test_equal_confidence_offers_no_confidence_recipe(self) -> None:
        # Sovereign mode labels every segment 1.0. "surest labels" would then be
        # a measurement-shaped lie.
        scan = _Scan(self.root / "sov", [("baseline", 3.0, 1.0), ("baseline", 2.0, 1.0),
                                         ("baseline", 1.5, 1.0)])
        plan, why = ingest_api.build_recipes(self.root / "sov", scan.result())
        self.assertIsNone(why)
        self.assertNotIn("confident", plan.get("baseline", {}))

    def test_a_dropped_outlier_segment_is_never_a_candidate(self) -> None:
        # The pipeline removes a segment that does not sound like the target
        # speaker from every stem. No recipe may put it back.
        res = self.scan.result()
        res["segments"][1]["outlier"] = "dropped"
        res["segments"][2]["outlier"] = "flagged"     # in the stems, still usable
        plan, why = ingest_api.build_recipes(self.root, res)
        self.assertIsNone(why)
        self.assertNotIn(1, plan["happy"]["full"])
        self.assertIn(2, plan["happy"]["full"])

    def test_mismatched_segment_audio_abandons_recipes_with_a_reason(self) -> None:
        res = self.scan.result()
        res["segments"][2]["dur"] = 30.0        # label no longer describes the wav
        plan, why = ingest_api.build_recipes(self.root, res)
        self.assertEqual({}, plan)
        self.assertIsNotNone(why)
        self.assertNotIn("recipes", res["stems"][0])

    def test_missing_segment_audio_abandons_recipes_with_a_reason(self) -> None:
        res = self.scan.result()
        (self.root / "seg_001.wav").unlink()
        plan, why = ingest_api.build_recipes(self.root, res)
        self.assertEqual({}, plan)
        self.assertIn("missing", why or "")


# ── 1. scratch isolation ─────────────────────────────────────────────────────
class _FakeChild:
    """Stand-in for the `python -m service.export_stems` audition child. Reads the
    spec, writes the `say` wav, and streams the real status protocol."""

    def __init__(self, *, ok: bool = True, silent: bool = False) -> None:
        self.ok = ok
        self.silent = silent
        self.specs: list[dict] = []

    def __call__(self, cmd, capture_output=False, timeout=None, **kw):
        spec = json.loads(Path(cmd[-1]).read_text("utf-8"))
        self.specs.append(spec)
        out = ""
        for st in spec["stems"]:
            if self.silent:
                continue
            if not self.ok:
                out += json.dumps({"emotion": st["emotion"], "ok": False,
                                   "error": "model load failed"}) + "\n"
                continue
            Path(st["dst"]).write_bytes(b"tensors")
            wav = Path(st["say"]["out"])
            write_wav(wav, 1.0)
            out += json.dumps({"emotion": st["emotion"], "ok": True,
                               "audio": str(wav), "audio_seconds": 1.0}) + "\n"
        return mock.Mock(returncode=0 if self.ok else 1,
                         stdout=out.encode(), stderr=b"boom" if not self.ok else b"")


class ScratchExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.src = self.root / "stem_happy.wav"
        write_wav(self.src, 2.0)          # deliberately UNDER MIN_STEM_SECONDS

    def tearDown(self) -> None:
        self._dir.cleanup()

    def _audition(self, child: _FakeChild) -> dict:
        with mock.patch.object(export_stems.subprocess, "run", side_effect=child):
            return export_stems.audition(
                src=self.src, text="hello there", language="english", quantize=False,
                scratch_dir=self.root / "_audition_abc")

    def test_returns_audio_and_leaves_nothing_behind(self) -> None:
        child = _FakeChild()
        res = self._audition(child)
        self.assertTrue(res["ok"])
        self.assertIsNone(res["error"])
        self.assertTrue(res["audio"].startswith(b"RIFF"))
        self.assertEqual(1.0, res["seconds"])
        self.assertFalse((self.root / "_audition_abc").exists())   # cleaned

    def test_a_short_stem_still_auditions(self) -> None:
        # commit refuses a 2s stem; being unable to HEAR it is what made the
        # flow a blind purchase. allow_short is the whole point of this path.
        self.assertLess(ingest._wav_seconds(self.src), ingest.MIN_STEM_SECONDS)
        self.assertTrue(self._audition(_FakeChild())["ok"])

    def test_nothing_is_ever_written_to_the_voice_roster(self) -> None:
        child = _FakeChild()
        with mock.patch("service.voices.mutate_meta") as reg:
            self._audition(child)
        reg.assert_not_called()
        # Every path in the spec stays inside the scratch dir, and every name
        # carries the prefix that makes a leak identifiable.
        stem = child.specs[0]["stems"][0]
        for p in (stem["dst"], stem["say"]["out"]):
            self.assertIn("_audition_", Path(p).name)
            self.assertEqual(self.root / "_audition_abc", Path(p).parent)

    def test_cleans_up_when_the_child_fails(self) -> None:
        res = self._audition(_FakeChild(ok=False))
        self.assertFalse(res["ok"])
        self.assertIn("model load failed", res["error"])
        self.assertIsNone(res["audio"])
        self.assertFalse((self.root / "_audition_abc").exists())

    def test_a_silent_child_is_a_named_failure_not_a_success(self) -> None:
        res = self._audition(_FakeChild(silent=True))
        self.assertFalse(res["ok"])
        self.assertTrue(res["error"])
        self.assertFalse((self.root / "_audition_abc").exists())

    def test_a_timeout_is_reported_as_a_timeout(self) -> None:
        import subprocess as sp
        with mock.patch.object(export_stems.subprocess, "run",
                               side_effect=sp.TimeoutExpired("x", 1)):
            res = export_stems.audition(
                src=self.src, text="hi", language="english", quantize=False,
                scratch_dir=self.root / "_audition_t")
        self.assertFalse(res["ok"])
        self.assertIn("timed out", res["error"])
        self.assertFalse((self.root / "_audition_t").exists())

    def test_gc_sweeps_only_aged_scratch_and_only_by_prefix(self) -> None:
        keep = self.root / "stem_happy.wav"
        fresh = self.root / "_audition_fresh"
        stale = self.root / "_audition_stale"
        for d in (fresh, stale):
            d.mkdir()
            (d / "x.safetensors").write_bytes(b"x")
        old = time.time() - 3600
        import os
        os.utime(stale, (old, old))
        removed = export_stems.gc_scratch(self.root, max_age_s=900.0)
        self.assertEqual(["_audition_stale"], removed)
        self.assertTrue(fresh.is_dir())
        self.assertTrue(keep.is_file())


class ChildSynthesisTests(unittest.TestCase):
    """The child's own audition half: one model load exports AND speaks."""

    def test_exports_then_speaks_with_the_loaded_back_state(self) -> None:
        loads = {"n": 0}
        prompts: list[str] = []
        said: list[str] = []

        class FakeModel:
            sample_rate = RATE

            def get_state_for_audio_prompt(self, src, truncate=True):
                prompts.append(str(src))
                return {"src": src}

            def save_voice(self, state, dst):
                Path(dst).write_bytes(b"tensors")

            def generate_audio(self, state, text, **kw):
                said.append(text)
                return [0.1] * (RATE // 2)

        class FakeTTSModel:
            @staticmethod
            def load_model(language, quantize):
                loads["n"] += 1
                return FakeModel()

        fake = types.ModuleType("pocket_tts")
        fake.TTSModel = FakeTTSModel
        with TemporaryDirectory() as td:
            wd = Path(td)
            src = wd / "stem_happy.wav"
            write_wav(src, 1.0)
            out = wd / "_audition_say.wav"
            spec = wd / "spec.json"
            spec.write_text(json.dumps({
                "language": "english", "quantize": False,
                "stems": [{"emotion": "_audition_1", "src": str(src),
                           "dst": str(wd / "_audition_1.safetensors"),
                           "say": {"text": "hear me", "out": str(out)}}]}), "utf-8")
            buf = io.StringIO()
            with mock.patch.dict(sys.modules, {"pocket_tts": fake}), \
                 contextlib.redirect_stdout(buf):
                rc = export_stems.main([str(spec)])
            line = json.loads(buf.getvalue().splitlines()[-1])
            self.assertEqual(0, rc)
            self.assertEqual(1, loads["n"])            # ONE load: export + speech
            self.assertEqual(["hear me"], said)
            # The state was loaded BACK from disk — the same round trip the
            # serving worker makes, so the audition hears the real thing.
            self.assertIn(str(wd / "_audition_1.safetensors"), prompts)
            self.assertTrue(line["ok"])
            self.assertEqual(0.5, line["audio_seconds"])
            self.assertTrue(out.is_file())

    def test_an_export_that_cannot_speak_is_a_failure(self) -> None:
        class FakeModel:
            sample_rate = RATE

            def get_state_for_audio_prompt(self, src, truncate=True):
                return {"src": src}

            def save_voice(self, state, dst):
                Path(dst).write_bytes(b"tensors")

            def generate_audio(self, state, text, **kw):
                raise RuntimeError("no voice today")

        fake = types.ModuleType("pocket_tts")
        fake.TTSModel = type("M", (), {"load_model": staticmethod(
            lambda language, quantize: FakeModel())})
        with TemporaryDirectory() as td:
            wd = Path(td)
            src = wd / "s.wav"
            write_wav(src, 1.0)
            spec = wd / "spec.json"
            spec.write_text(json.dumps({
                "language": "english", "quantize": False,
                "stems": [{"emotion": "_audition_1", "src": str(src),
                           "dst": str(wd / "_audition_1.safetensors"),
                           "say": {"text": "hi", "out": str(wd / "o.wav")}}]}), "utf-8")
            buf = io.StringIO()
            with mock.patch.dict(sys.modules, {"pocket_tts": fake}), \
                 contextlib.redirect_stdout(buf), \
                 mock.patch.object(export_stems.subprocess, "run",
                                   return_value=mock.Mock(returncode=1, stderr=b"")):
                rc = export_stems.main([str(spec)])
            line = json.loads(buf.getvalue().splitlines()[-1])
        self.assertEqual(1, rc)
        self.assertFalse(line["ok"])
        self.assertIn("synthesis failed", line["error"])


# ── the HTTP surface ─────────────────────────────────────────────────────────
class AuditionEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.client = TestClient(appmod.app, raise_server_exceptions=False)
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()
        self.scan = _Scan(self.root / "j1", [
            ("happy", 3.0, 0.9), ("happy", 1.0, 0.4), ("happy", 2.0, 0.8)])
        res = self.scan.result()
        self.plan, _ = ingest_api.build_recipes(self.root / "j1", res)
        self.job = {
            "id": "j1", "status": "done", "step": "stem", "mode": "cloud",
            "steps": [], "partial": {}, "speakers": [{"id": "speaker_0"}],
            "duration": 60, "result": res, "error": None, "note": None,
            "limits": None, "detection": None, "work_dir": str(self.root / "j1"),
            "created": time.time(), "touched": time.time(), "clip_sha256": "abc",
            "cancel": False, "committed": None,
            "recipes": {"applied": {}, "skipped": [], "unavailable": None},
            "recipe_plan": self.plan}
        ingest_api.JOBS["j1"] = self.job

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)
        self._dir.cleanup()

    def _post(self, body: dict, child: _FakeChild | None = None):
        child = child or _FakeChild()
        with mock.patch.object(export_stems.subprocess, "run", side_effect=child):
            return self.client.post("/v1/ingest/j1/audition", json=body)

    def test_serves_a_clone_with_its_facts_on_the_headers(self) -> None:
        r = self._post({"emotion": "happy", "text": "hear me as a voice"})
        self.assertEqual(200, r.status_code)
        self.assertEqual("audio/wav", r.headers["content-type"])
        self.assertTrue(r.content.startswith(b"RIFF"))
        self.assertEqual("happy", r.headers["X-Audition-Emotion"])
        self.assertEqual("full", r.headers["X-Audition-Recipe"])
        self.assertEqual("1.0", r.headers["X-Audition-Seconds"])
        self.assertTrue(float(r.headers["X-Audition-Source-Seconds"]) > 0)
        self.assertIn("no-store", r.headers["cache-control"])

    def test_auditions_a_named_recipe_from_its_own_wav(self) -> None:
        rid = next(k for k in self.plan["happy"] if k != "full")
        child = _FakeChild()
        r = self._post({"emotion": "happy", "recipe": rid}, child)
        self.assertEqual(200, r.status_code)
        self.assertEqual(rid, r.headers["X-Audition-Recipe"])
        self.assertEqual(str(self.root / "j1" / f"stem_happy__{rid}.wav"),
                         child.specs[0]["stems"][0]["src"])

    def test_defaults_the_line_rather_than_refusing_an_empty_one(self) -> None:
        child = _FakeChild()
        self._post({"emotion": "happy", "text": "   "}, child)
        self.assertEqual(ingest_api.DEFAULT_AUDITION_TEXT,
                         child.specs[0]["stems"][0]["say"]["text"])

    def test_refuses_an_unknown_recipe_and_an_unoffered_one(self) -> None:
        self.assertEqual(400, self._post({"emotion": "happy", "recipe": "../etc"}).status_code)
        # A real recipe id that was not offered for THIS emotion: 404, not a
        # silent fall back to the default splice.
        self.assertEqual(404, self._post({"emotion": "sad", "recipe": "longest"}).status_code)

    def test_refuses_an_overlong_line_and_a_bad_emotion(self) -> None:
        self.assertEqual(400, self._post({"emotion": "happy", "text": "x" * 500}).status_code)
        self.assertEqual(400, self._post({"emotion": "../../etc/passwd"}).status_code)

    def test_needs_a_finished_scan(self) -> None:
        self.job["status"] = "running"
        self.assertEqual(409, self._post({"emotion": "happy"}).status_code)

    def test_404s_a_stem_that_does_not_exist(self) -> None:
        self.assertEqual(404, self._post({"emotion": "angry"}).status_code)

    def test_holds_no_job_slot_so_a_busy_backend_still_auditions(self) -> None:
        # The admission gate that refuses scans/commits must not refuse an
        # audition: it is a read-only experiment on a scan that already finished.
        busy = {f"b{i}": {"status": "running", "work_dir": str(self.root)}
                for i in range(ingest_api.MAX_ACTIVE_JOBS + 2)}
        ingest_api.JOBS.update(busy)
        self.assertEqual(200, self._post({"emotion": "happy"}).status_code)

    def test_refuses_with_a_named_429_when_the_audition_budget_is_full(self) -> None:
        with mock.patch.object(ingest_api, "MAX_ACTIVE_AUDITIONS", 0):
            r = self._post({"emotion": "happy"})
        self.assertEqual(429, r.status_code)
        self.assertIn("audition", r.json()["detail"])
        self.assertEqual(str(ingest_api.AUDITION_RETRY_AFTER_S), r.headers["Retry-After"])
        # And the slot is handed back: the next call is admitted.
        self.assertEqual(200, self._post({"emotion": "happy"}).status_code)

    def test_a_failed_audition_is_sanitized_and_frees_the_slot(self) -> None:
        r = self._post({"emotion": "happy"}, _FakeChild(ok=False))
        self.assertEqual(500, r.status_code)
        self.assertNotIn("model load failed", r.json()["detail"])   # no child guts
        self.assertEqual(0, ingest_api._active_auditions)

    def test_the_recipe_plan_is_never_published(self) -> None:
        body = self.client.get("/v1/ingest/j1").json()
        self.assertNotIn("recipe_plan", body)
        self.assertIn("recipes", body)
        stem = next(s for s in body["result"]["stems"] if s["emotion"] == "happy")
        self.assertTrue(stem["recipes"])
        for r in stem["recipes"]:
            self.assertNotIn("indices", r)


# ── 3. a chosen recipe actually commits ──────────────────────────────────────
class CommitRecipeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.scan = _Scan(self.root, [
            ("happy", 3.0, 0.9), ("happy", 1.0, 0.4), ("happy", 2.0, 0.8)])
        res = self.scan.result()
        self.plan, _ = ingest_api.build_recipes(self.root, res)
        self.job = {"id": "j2", "status": "committing", "work_dir": str(self.root),
                    "cancel": False, "recipe_plan": self.plan,
                    "recipes": {"applied": {}, "skipped": [], "unavailable": None}}

    def tearDown(self) -> None:
        self._dir.cleanup()

    def test_the_stem_the_exporter_reads_becomes_the_chosen_splice(self) -> None:
        rid = next(k for k in self.plan["happy"] if k != "full")
        chosen = (self.root / f"stem_happy__{rid}.wav").read_bytes()
        self.assertNotEqual(chosen, (self.root / "stem_happy.wav").read_bytes())
        ingest_api._apply_recipes(self.job, ["happy"], {"happy": rid})
        self.assertEqual(chosen, (self.root / "stem_happy.wav").read_bytes())
        self.assertEqual({"happy": rid}, self.job["recipes"]["applied"])
        self.assertEqual([], self.job["recipes"]["skipped"])

    def test_the_default_choice_changes_nothing(self) -> None:
        before = (self.root / "stem_happy.wav").read_bytes()
        ingest_api._apply_recipes(self.job, ["happy"], {"happy": "full"})
        self.assertEqual(before, (self.root / "stem_happy.wav").read_bytes())
        self.assertEqual({}, self.job["recipes"]["applied"])

    def test_a_choice_that_cannot_be_applied_is_named_not_swallowed(self) -> None:
        rid = next(k for k in self.plan["happy"] if k != "full")
        (self.root / f"stem_happy__{rid}.wav").unlink()
        ingest_api._apply_recipes(self.job, ["happy"], {"happy": rid})
        self.assertEqual({}, self.job["recipes"]["applied"])
        self.assertEqual(1, len(self.job["recipes"]["skipped"]))
        self.assertEqual("happy", self.job["recipes"]["skipped"][0]["emotion"])
        self.assertTrue(self.job["recipes"]["skipped"][0]["why"])

    def test_an_unoffered_recipe_is_named_and_never_reaches_the_filesystem(self) -> None:
        ingest_api._apply_recipes(self.job, ["sad"], {"sad": "tightest"})
        self.assertEqual({}, self.job["recipes"]["applied"])
        self.assertIn("not offered", self.job["recipes"]["skipped"][0]["why"])


if __name__ == "__main__":
    unittest.main()
