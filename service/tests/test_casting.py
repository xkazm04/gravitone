"""The Segment Casting Board: the segment layer made visible, then editable.

A stem used to be an opaque aggregate. `label_and_stem` writes a wav per segment
and reports each one's emotion, confidence, cue and duration - then `concat_wavs`
collapses all of it into a single number, and a mislabelled laugh or a stem 0.4s
under the clone minimum was unfixable except by finding a different recording.

Four promises are pinned here, because each is a thing a user must be able to
trust without being able to check it:

  1. **A segment can be heard.** `/segment/{i}` serves the exact wav that fed
     (or was refused from) a stem - including the REJECTED ones, which are the
     ones somebody actually wants to hear.
  2. **A re-splice tells the truth.** The seconds and `eligible` that come back
     are measured from the file that was just written, so the badge on screen and
     the audio a commit will clone are the same thing.
  3. **Nothing escapes the workdir.** No roster row, no VOICES_DIR write, no
     filename reachable from a request body, no job slot consumed.
  4. **Every refusal is named, and reset really resets.** Bad indices, dropped
     outliers, committed jobs and emptied stems each get their own sentence, and
     "reset to proposed" restores the pipeline's splice, its notes AND its
     candidate takes.

No model, no torch, no ffmpeg: real wavs on disk, and the one test that crosses
into the audition path stubs the export child at the subprocess boundary.
"""
from __future__ import annotations

import copy
import json
import math
import time
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


def write_wav(path: Path, seconds: float, *, loud: float = 0.3) -> None:
    """A real 16-bit mono wav with alternating loud/quiet 100 ms blocks."""
    block = int(0.1 * RATE)
    frames = bytearray()
    n = int(seconds * RATE)
    i = 0
    while i < n:
        amp = loud if (i // block) % 2 == 0 else 0.02
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


def seconds_of(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return round(w.getnframes() / w.getframerate(), 2)


class _Scan:
    """A finished scan on disk, built the way `label_and_stem` builds one: a wav
    per segment, one spliced stem per emotion (baseline through plan_baseline, so
    the borrow behaviour this board has to restore is really exercised)."""

    def __init__(self, root: Path, segs: list[tuple[str, float, float]], *,
                 min_stem: float = 4.0) -> None:
        self.dir = root
        self.min_stem = min_stem
        self.segments: list[dict] = []
        labs: list[dict] = []
        for i, (emo, dur, conf) in enumerate(segs):
            wav = root / f"seg_{i:03d}.wav"
            write_wav(wav, dur, loud=0.2 + 0.1 * (i % 3))
            self.segments.append({"i": i, "emotion": emo, "confidence": conf,
                                  "cue": f"cue {i}", "dur": round(dur, 2),
                                  "text": f"line {i}", "model": "test",
                                  "failure": None, "ok": True, "outlier": None,
                                  "escalation": None})
            labs.append({"i": i, "emotion": emo, "wav": str(wav)})
        by_emotion: dict[str, list[dict]] = {}
        for lab in labs:
            by_emotion.setdefault(lab["emotion"], []).append(lab)
        self.stems: list[dict] = []
        plan = ingest.plan_baseline(by_emotion, min_stem)
        if plan.labs:
            sp = ingest.concat_wavs([Path(l["wav"]) for l in plan.labs],
                                    root / f"stem_{ingest.BASELINE}.wav")
            self.stems.append({"emotion": ingest.BASELINE, "seconds": sp.seconds,
                               "segments": sp.segments,
                               "eligible": sp.seconds >= min_stem, "cues": [],
                               "note": ingest.baseline_note(plan, sp.seconds, min_stem)})
        for emo, group in by_emotion.items():
            if emo == ingest.BASELINE:
                continue
            sp = ingest.concat_wavs([Path(l["wav"]) for l in group],
                                    root / f"stem_{emo}.wav")
            self.stems.append({"emotion": emo, "seconds": sp.seconds,
                               "segments": sp.segments,
                               "eligible": sp.seconds >= min_stem,
                               "cues": [], "note": None})

    def result(self) -> dict:
        return {"target": "speaker_0", "utterances": len(self.segments),
                "min_stem": self.min_stem, "stems": [dict(s) for s in self.stems],
                "spend": {}, "segments": [dict(s) for s in self.segments],
                "duration": 60, "speakers": ["speaker_0"], "mode": "cloud"}


class _Board(unittest.TestCase):
    """One finished job in JOBS, with a client pointed at the real app."""

    SEGS = [
        ("baseline", 2.0, 0.9),
        ("happy", 3.0, 0.9),
        ("happy", 1.2, 0.4),
        ("happy", 2.0, 0.8),
        ("sad", 1.5, 0.7),
    ]

    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.wd = self.root / "j1"
        self.client = TestClient(appmod.app, raise_server_exceptions=False)
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()
        self.scan = _Scan(self.wd, self.SEGS)
        res = self.scan.result()
        self.plan, _ = ingest_api.build_recipes(self.wd, res)
        # The job holds the plan itself and a withdrawal mutates it in place, so
        # "what was offered at scan time" needs its own copy to compare against.
        self.plan_at_scan = copy.deepcopy(self.plan)
        self.job = {
            "id": "j1", "status": "done", "step": "stem", "mode": "cloud",
            "steps": [], "partial": {}, "speakers": [{"id": "speaker_0"}],
            "duration": 60, "result": res, "error": None, "note": None,
            "limits": None, "detection": None, "work_dir": str(self.wd),
            "created": time.time(), "touched": time.time(), "clip_sha256": "abc",
            "cancel": False, "committed": None, "casting": None,
            "recipes": {"applied": {}, "skipped": [], "unavailable": None},
            "recipe_plan": self.plan}
        ingest_api.JOBS["j1"] = self.job

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)
        self._dir.cleanup()

    def post(self, body: dict):
        return self.client.post("/v1/ingest/j1/stems", json=body)

    def stem(self, payload: dict, emotion: str) -> dict:
        return next(s for s in payload["stems"] if s["emotion"] == emotion)


# ── 1. a segment can be heard ────────────────────────────────────────────────
class SegmentAudioTests(_Board):
    def test_serves_the_exact_wav_that_fed_the_stem(self) -> None:
        r = self.client.get("/v1/ingest/j1/segment/1")
        self.assertEqual(200, r.status_code)
        self.assertEqual("audio/wav", r.headers["content-type"])
        self.assertEqual((self.wd / "seg_001.wav").read_bytes(), r.content)

    def test_the_labels_carry_their_own_index_and_usability(self) -> None:
        # The join used to be positional-and-unstated; every consumer rebuilt it.
        body = self.client.get("/v1/ingest/j1").json()
        for pos, s in enumerate(body["result"]["segments"]):
            self.assertEqual(pos, s["i"])
            self.assertIn("ok", s)
            self.assertIn("outlier", s)

    def test_the_proposed_splice_is_the_pipelines_own_not_the_labels(self) -> None:
        # A client deriving "which segments are in this stem" from the labels
        # would draw a baseline nobody built: plan_baseline tops a short neutral
        # stem up from other emotions, in BORROW order, not index order.
        _rows, proposed, why = ingest_api._board(self.wd, self.job["result"])
        self.assertIsNone(why)
        self.assertEqual([1, 2, 3], proposed["happy"])
        self.assertEqual(0, proposed[ingest.BASELINE][0])       # neutral first
        self.assertIn(4, proposed[ingest.BASELINE])             # ... then borrowed
        self.assertNotEqual(sorted(proposed[ingest.BASELINE]),
                            proposed[ingest.BASELINE])

    def test_a_rejected_segment_is_still_playable(self) -> None:
        # "we removed this one" is exactly the claim a user wants to check.
        self.job["result"]["segments"][2]["outlier"] = "dropped"
        r = self.client.get("/v1/ingest/j1/segment/2")
        self.assertEqual(200, r.status_code)

    def test_names_each_404_rather_than_saying_not_found(self) -> None:
        out_of_range = self.client.get("/v1/ingest/j1/segment/99")
        self.assertEqual(404, out_of_range.status_code)
        self.assertIn("not part of this scan", out_of_range.json()["detail"])

        (self.wd / "seg_004.wav").unlink()
        self.job["result"]["segments"][4]["failure"] = "extract"
        gone = self.client.get("/v1/ingest/j1/segment/4")
        self.assertEqual(404, gone.status_code)
        self.assertIn("could not be decoded", gone.json()["detail"])

    def test_an_expired_job_answers_the_poller_s_own_shape(self) -> None:
        r = self.client.get("/v1/ingest/nope/segment/0")
        self.assertEqual(404, r.status_code)
        self.assertEqual("expired", r.json()["status"])


# ── 2. a re-splice tells the truth ───────────────────────────────────────────
class RespliceTests(_Board):
    def test_excluding_a_segment_shortens_the_stem_and_says_so(self) -> None:
        before = self.stemrow("happy")["seconds"]
        r = self.post({"assignments": {"happy": [1, 3]}})
        self.assertEqual(200, r.status_code)
        row = self.stem(r.json(), "happy")
        self.assertLess(row["seconds"], before)
        self.assertEqual([1, 3], row["assigned"])
        self.assertEqual(2, row["segments"])
        self.assertTrue(row["edited"])
        # Measured from the file that was actually written.
        self.assertEqual(seconds_of(self.wd / "stem_happy.wav"), row["seconds"])

    def stemrow(self, emotion: str) -> dict:
        return next(s for s in self.job["result"]["stems"] if s["emotion"] == emotion)

    def test_the_ledger_the_poller_reads_moves_with_it(self) -> None:
        self.post({"assignments": {"happy": [1]}})
        body = self.client.get("/v1/ingest/j1").json()
        row = next(s for s in body["result"]["stems"] if s["emotion"] == "happy")
        self.assertEqual(1, row["segments"])
        self.assertEqual(sorted(["happy"]), body["casting"]["edited"])
        self.assertEqual([1], body["casting"]["assignments"]["happy"])

    def test_a_short_stem_can_be_watched_crossing_the_line(self) -> None:
        # The whole point of the board: `sad` holds 1.5s of a 4s minimum, and no
        # amount of re-uploading fixes that - but casting more audio into it does.
        self.assertFalse(self.stemrow("sad")["eligible"])
        short = self.post({"assignments": {"sad": [4]}})
        self.assertFalse(self.stem(short.json(), "sad")["eligible"])
        grown = self.post({"assignments": {"sad": [4, 1, 3]}})
        row = self.stem(grown.json(), "sad")
        self.assertTrue(row["eligible"])
        self.assertGreaterEqual(row["seconds"], row_min := grown.json()["min_stem"])
        self.assertGreaterEqual(seconds_of(self.wd / "stem_sad.wav"), row_min)
        # ... and the badge the ledger shows agrees with the file.
        self.assertTrue(self.stemrow("sad")["eligible"])

    def test_identical_assignments_re_splice_nothing_and_answer_the_same(self) -> None:
        # This endpoint is a debounce target: a repeated body is the normal case.
        first = self.post({"assignments": {"happy": [1, 2]}}).json()
        wav = (self.wd / "stem_happy.wav").read_bytes()
        second = self.post({"assignments": {"happy": [1, 2]}}).json()
        self.assertEqual(["happy"], first["changed"])
        self.assertEqual([], second["changed"])
        self.assertEqual(first["stems"], second["stems"])
        self.assertEqual(wav, (self.wd / "stem_happy.wav").read_bytes())

    def test_unnamed_emotions_are_left_exactly_alone(self) -> None:
        before = (self.wd / "stem_sad.wav").read_bytes()
        r = self.post({"assignments": {"happy": [1]}})
        self.assertEqual(before, (self.wd / "stem_sad.wav").read_bytes())
        self.assertFalse(self.stem(r.json(), "sad")["edited"])

    def test_moving_a_segment_into_another_emotion_states_the_mix(self) -> None:
        r = self.post({"assignments": {"happy": [1, 3], "sad": [4, 2]}})
        row = self.stem(r.json(), "sad")
        self.assertEqual([4, 2], row["assigned"])
        self.assertIn("happy", row["note"] or "")
        self.assertIn("not purely sad", row["note"] or "")
        # An unmixed selection makes no claim at all.
        self.assertIsNone(self.stem(r.json(), "happy")["note"])

    def test_a_stem_scored_for_the_old_splice_drops_its_number(self) -> None:
        self.stemrow("happy")["identity"] = 0.91
        self.post({"assignments": {"happy": [1]}})
        self.assertNotIn("identity", self.stemrow("happy"))


# ── 3. nothing escapes the workdir ───────────────────────────────────────────
class ContainmentTests(_Board):
    def test_never_writes_to_the_voice_roster(self) -> None:
        with mock.patch("service.voices.mutate_meta") as reg:
            self.post({"assignments": {"happy": [1, 2]}})
        reg.assert_not_called()

    def test_writes_only_inside_this_job_s_workdir(self) -> None:
        before = {p for p in self.root.rglob("*")}
        self.post({"assignments": {"happy": [1], "sad": [4, 2]}})
        for p in {p for p in self.root.rglob("*")} - before:
            self.assertEqual(self.wd, p.parent)

    def test_holds_no_job_slot_so_a_busy_backend_still_re_splices(self) -> None:
        busy = {f"b{i}": {"status": "running", "work_dir": str(self.root)}
                for i in range(ingest_api.MAX_ACTIVE_JOBS + 2)}
        ingest_api.JOBS.update(busy)
        self.assertEqual(200, self.post({"assignments": {"happy": [1, 2]}}).status_code)

    def test_an_emotion_that_could_reach_a_filename_is_refused(self) -> None:
        for bad in ("../../etc/passwd", "stem_happy.wav", ""):
            r = self.post({"assignments": {bad: [1]}})
            self.assertEqual(400, r.status_code, bad)
            self.assertFalse(list(self.root.glob("**/*passwd*")))


# ── 4. named refusals, and a real reset ──────────────────────────────────────
class RefusalTests(_Board):
    def test_an_index_that_is_not_a_segment(self) -> None:
        r = self.post({"assignments": {"happy": [99]}})
        self.assertEqual(400, r.status_code)
        self.assertIn("not part of this scan", r.json()["detail"])

    def test_a_segment_the_pipeline_removed_is_named_not_silently_dropped(self) -> None:
        # Re-introducing a bystander voice is not the user's to undo by clicking.
        self.job["result"]["segments"][2]["outlier"] = "dropped"
        r = self.post({"assignments": {"happy": [1, 2]}})
        self.assertEqual(400, r.status_code)
        self.assertIn("not the target speaker", r.json()["detail"])

    def test_a_segment_with_no_audio_is_named(self) -> None:
        (self.wd / "seg_002.wav").unlink()
        self.job["result"]["segments"][2]["failure"] = "extract"
        r = self.post({"assignments": {"happy": [1, 2]}})
        self.assertEqual(400, r.status_code)
        self.assertIn("could not be decoded", r.json()["detail"])

    def test_emptying_a_stem_points_at_descope_instead(self) -> None:
        r = self.post({"assignments": {"happy": []}})
        self.assertEqual(400, r.status_code)
        self.assertIn("descope", r.json()["detail"])

    def test_an_emotion_this_scan_has_no_stem_for(self) -> None:
        r = self.post({"assignments": {"angry": [1]}})
        self.assertEqual(400, r.status_code)
        self.assertIn("not one of this scan's stems", r.json()["detail"])

    def test_the_same_segment_twice_in_one_stem(self) -> None:
        r = self.post({"assignments": {"happy": [1, 1]}})
        self.assertEqual(400, r.status_code)
        self.assertIn("twice", r.json()["detail"])

    def test_a_committed_job_can_no_longer_be_re_cast(self) -> None:
        for status, phrase in (("committing", "already been committed"),
                               ("committed", "already been committed"),
                               ("running", "finished scan")):
            self.job["status"] = status
            r = self.post({"assignments": {"happy": [1]}})
            self.assertEqual(409, r.status_code, status)
            self.assertIn(phrase, r.json()["detail"])

    def test_an_expired_job_answers_the_poller_s_own_shape(self) -> None:
        r = self.client.post("/v1/ingest/nope/stems", json={"assignments": {"a": [0]}})
        self.assertEqual(404, r.status_code)
        self.assertEqual("expired", r.json()["status"])

    def test_reset_restores_the_proposed_splice_its_notes_and_its_takes(self) -> None:
        proposed = {s["emotion"]: (s["seconds"], s["segments"], s.get("note"),
                                   bool(s.get("recipes")))
                    for s in self.job["result"]["stems"]}
        base_wav = (self.wd / "stem_baseline.wav").read_bytes()
        # The baseline here is a BORROWED stem (2.0s of neutral against a 4s
        # minimum), so its note is the one a reset most has to put back.
        self.assertTrue(proposed[ingest.BASELINE][2])

        edited = self.post({"assignments": {"happy": [1], ingest.BASELINE: [0, 4]}})
        self.assertEqual(200, edited.status_code)
        self.assertNotEqual(base_wav, (self.wd / "stem_baseline.wav").read_bytes())
        self.assertFalse(self.stem(edited.json(), "happy")["takes"])

        back = self.post({"reset": True})
        self.assertTrue(back.json()["reset"])
        self.assertEqual([], back.json()["edited"])
        self.assertEqual(base_wav, (self.wd / "stem_baseline.wav").read_bytes())
        for s in self.job["result"]["stems"]:
            self.assertEqual(proposed[s["emotion"]],
                             (s["seconds"], s["segments"], s.get("note"),
                              bool(s.get("recipes"))), s["emotion"])
        self.assertEqual(self.plan_at_scan, self.job["recipe_plan"])

    def test_an_empty_body_means_reset(self) -> None:
        self.post({"assignments": {"happy": [1]}})
        r = self.post({})
        self.assertTrue(r.json()["reset"])
        self.assertEqual([], r.json()["edited"])


# ── the seam with the Audition Room ──────────────────────────────────────────
class AuditionCoherenceTests(_Board):
    """"Re-splice then audition" has to hear the NEW stem, and an alternative
    take computed from the old selection must stop being offered rather than
    quietly clone a splice nobody chose."""

    class _FakeChild:
        def __init__(self) -> None:
            self.specs: list[dict] = []

        def __call__(self, cmd, capture_output=False, timeout=None, **kw):
            spec = json.loads(Path(cmd[-1]).read_text("utf-8"))
            self.specs.append(spec)
            out = ""
            for st in spec["stems"]:
                Path(st["dst"]).write_bytes(b"tensors")
                wav = Path(st["say"]["out"])
                write_wav(wav, 1.0)
                out += json.dumps({"emotion": st["emotion"], "ok": True,
                                   "audio": str(wav), "audio_seconds": 1.0}) + "\n"
            return mock.Mock(returncode=0, stdout=out.encode(), stderr=b"")

    def audition(self, body: dict, child):
        with mock.patch.object(export_stems.subprocess, "run", side_effect=child):
            return self.client.post("/v1/ingest/j1/audition", json=body)

    def test_an_audition_after_a_re_splice_clones_the_new_stem(self) -> None:
        self.post({"assignments": {"happy": [1]}})
        child = self._FakeChild()
        r = self.audition({"emotion": "happy"}, child)
        self.assertEqual(200, r.status_code)
        src = Path(child.specs[0]["stems"][0]["src"])
        self.assertEqual(self.wd / "stem_happy.wav", src)
        # The header states the length of what was actually cloned.
        self.assertEqual(seconds_of(src), float(r.headers["X-Audition-Source-Seconds"]))

    def test_an_alternative_take_is_withdrawn_rather_than_left_lying(self) -> None:
        rid = next(k for k in self.plan["happy"] if k != ingest_api.RECIPE_FULL)
        self.assertEqual(200, self.audition({"emotion": "happy", "recipe": rid},
                                            self._FakeChild()).status_code)
        self.post({"assignments": {"happy": [1, 3]}})
        self.assertFalse((self.wd / f"stem_happy__{rid}.wav").exists())
        stale = self.audition({"emotion": "happy", "recipe": rid}, self._FakeChild())
        self.assertEqual(404, stale.status_code)
        self.assertIn("not offered", stale.json()["detail"])

    def test_a_stale_recipe_choice_is_named_at_commit_not_swallowed(self) -> None:
        rid = next(k for k in self.plan["happy"] if k != ingest_api.RECIPE_FULL)
        self.post({"assignments": {"happy": [1, 3]}})
        chosen = (self.wd / "stem_happy.wav").read_bytes()
        ingest_api._apply_recipes(self.job, ["happy"], {"happy": rid})
        self.assertEqual({}, self.job["recipes"]["applied"])
        self.assertEqual("happy", self.job["recipes"]["skipped"][0]["emotion"])
        # ... and the user's own splice is what stayed on disk to be cloned.
        self.assertEqual(chosen, (self.wd / "stem_happy.wav").read_bytes())


if __name__ == "__main__":
    unittest.main()
