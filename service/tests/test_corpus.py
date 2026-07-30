"""The Voice Corpus: ingest stops being disposable.

Everything the pipeline learns about a person used to die with the workdir. These
tests pin the four properties that make keeping it defensible instead of merely
useful — OPT-IN (nothing is written unless asked), CONSENT-GATED (no attestation,
no capture), VISIBLE (itemized) and DELETABLE (by clip hash, completely) — plus
the pay-off: a re-derivation that rebuilds a character's stems from every take
the box holds, so an emotion too short in one recording clears the clone minimum
across takes.

Real wavs (they are spliced and measured for real), no torch: the one-load export
child is the same fake the lifecycle suite uses.
"""
from __future__ import annotations

import dataclasses
import io
import json
import math
import time
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # noqa: F401 - shims before app import

import service.ingest as ing
import service.ingest_api as ingest_api
import service.voices as vc
from fastapi.testclient import TestClient

import service.app as appmod

RATE = 24000


def write_wav(path: Path, seconds: float, freq: float = 220.0,
              amp: float = 0.3) -> Path:
    """A real 24 kHz mono 16-bit tone — the exact shape `to_wav` produces, so
    splicing, level measurement and duration all behave as they do in the app."""
    n = int(seconds * RATE)
    frames = bytearray()
    for i in range(n):
        v = int(amp * 32767 * math.sin(2 * math.pi * freq * i / RATE))
        frames += int(v).to_bytes(2, "little", signed=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))
    return path


class _FakeExportPopen:
    """The one-load `service.export_stems` child: reads the spec, writes each
    dst, streams one JSON status line per stem."""

    spawned = 0

    def __init__(self, cmd, stdout=None, stderr=None, text=None):
        type(self).spawned += 1
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
        pass

    def kill(self):
        pass


def scan_result(segments: list[dict], stems: list[dict],
                fidelity: dict | None = None) -> dict:
    return {"target": "speaker_0", "utterances": len(segments), "min_stem": 4.0,
            "stems": stems, "segments": segments,
            "fidelity": fidelity or {"version": 1, "available": False,
                                     "reason": "not measured", "stems": {}}}


class CorpusCase(unittest.TestCase):
    """A tmp corpus dir + a tmp voices registry, wired the way the app wires
    them, so nothing here touches the checkout."""

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        self.root = Path(self._td.name)
        self.corpus = self.root / "corpus"
        self.voices = self.root / "voices"
        self.voices.mkdir(parents=True, exist_ok=True)
        self.settings = dataclasses.replace(
            ing.SETTINGS, corpus_dir=str(self.corpus),
            corpus_max_bytes=2 * 1024 * 1024 * 1024, corpus_stem_seconds=30.0)
        self._patches = [
            mock.patch.object(ing, "SETTINGS", self.settings),
            mock.patch.object(ingest_api, "SETTINGS", self.settings),
            mock.patch.object(ing, "VOICES_DIR", self.voices),
            mock.patch.object(vc, "VOICES_DIR", self.voices),
            mock.patch.object(vc, "META_PATH", self.voices / "_meta.json"),
            mock.patch.object(vc, "_META_LOCK_PATH", self.voices / "._meta.lock"),
        ]
        for p in self._patches:
            p.start()
        vc.invalidate()

    def tearDown(self) -> None:
        for p in reversed(self._patches):
            p.stop()
        vc.invalidate()
        self._td.cleanup()

    # ── fixtures ─────────────────────────────────────────────────────────────
    def make_job(self, name: str, *, segments: list[tuple[str, float, float]],
                 stem_seconds: dict[str, float] | None = None,
                 failures: dict[int, str] | None = None,
                 outliers: dict[int, str] | None = None,
                 fidelity: dict | None = None) -> tuple[Path, dict]:
        """A finished scan's workdir + its `result`, with real audio on disk."""
        wd = self.root / f"work-{name}"
        wd.mkdir(parents=True, exist_ok=True)
        rows: list[dict] = []
        by_emotion: dict[str, list[Path]] = {}
        for i, (emo, secs, conf) in enumerate(segments):
            wav = write_wav(wd / f"seg_{i:03d}.wav", secs, 200 + 20 * i)
            rows.append({"emotion": emo, "confidence": conf, "cue": f"cue {i}",
                         "dur": round(secs, 2), "text": f"line {i}",
                         "model": "test", "failure": (failures or {}).get(i),
                         "outlier": (outliers or {}).get(i), "escalation": None})
            by_emotion.setdefault(emo, []).append(wav)
        stems = []
        for emo, wavs in by_emotion.items():
            secs = (stem_seconds or {}).get(emo, sum(
                round(w.stat().st_size / (2 * RATE), 2) for w in wavs))
            write_wav(wd / f"stem_{emo}.wav", max(secs, 0.2))
            stems.append({"emotion": emo, "seconds": round(secs, 2),
                          "segments": len(wavs), "eligible": secs >= 4.0,
                          "cues": [], "note": None})
        return wd, scan_result(rows, stems, fidelity)

    def capture(self, cid: str, name: str, sha: str, **kw) -> dict:
        wd, result = self.make_job(name, **kw)
        return ing.capture_corpus(wd, cid, result, clip_sha256=sha,
                                  consent="I own this voice.", mode="sovereign",
                                  levels={"threshold_db": -41.0},
                                  committed=[{"voice_id": f"{cid}-baseline-1"}])


# ── capture ───────────────────────────────────────────────────────────────────
class CaptureTests(CorpusCase):
    def test_capture_copies_facts_and_leaves_the_workdir_alone(self):
        wd, result = self.make_job(
            "a", segments=[("baseline", 2.0, 0.9), ("happy", 1.5, 0.8)])
        before = sorted(p.name for p in wd.iterdir())
        res = ing.capture_corpus(wd, "ada", result, clip_sha256="a" * 64,
                                 consent="I own this voice.", mode="cloud",
                                 levels={"threshold_db": -40.0},
                                 committed=[{"voice_id": "ada-baseline-1"}])
        self.assertTrue(res["captured"], res)
        clip = self.corpus / "ada" / ("a" * 64)
        self.assertTrue((clip / "segments" / "seg_000.wav").is_file())
        self.assertTrue((clip / "segments" / "seg_001.wav").is_file())
        self.assertTrue((clip / "stems" / "stem_baseline.wav").is_file())
        self.assertTrue((clip / "segments.json").is_file())
        idx = json.loads((self.corpus / "ada" / ing.CORPUS_INDEX).read_text("utf-8"))
        self.assertEqual(idx["schema"], ing.CORPUS_SCHEMA)
        self.assertEqual(len(idx["clips"]), 1)
        self.assertEqual(idx["clips"][0]["consent"]["statement"], "I own this voice.")
        self.assertEqual(idx["clips"][0]["consent"]["clip_sha256"], "a" * 64)
        self.assertEqual(idx["clips"][0]["levels"], {"threshold_db": -40.0})
        self.assertEqual(idx["clips"][0]["voices"], ["ada-baseline-1"])
        # COPY, never move: GC still owns the workdir.
        self.assertEqual(sorted(p.name for p in wd.iterdir()), before)

    def test_recapturing_the_same_clip_is_a_noop(self):
        self.assertTrue(self.capture("ada", "a", "b" * 64,
                                     segments=[("baseline", 2.0, 0.9)])["captured"])
        rev = ing.load_corpus("ada")["rev"]
        again = self.capture("ada", "a2", "b" * 64, segments=[("baseline", 2.0, 0.9)])
        self.assertFalse(again["captured"])
        self.assertTrue(again["already"])
        self.assertIn("already in the corpus", again["reason"])
        idx = ing.load_corpus("ada")
        self.assertEqual(len(idx["clips"]), 1)
        self.assertEqual(idx["rev"], rev)          # append-only, and not appended

    def test_capture_without_consent_is_refused_by_name(self):
        wd, result = self.make_job("c", segments=[("baseline", 2.0, 0.9)])
        res = ing.capture_corpus(wd, "ada", result, clip_sha256="c" * 64,
                                 consent="  ")
        self.assertFalse(res["captured"])
        self.assertIn("attestation", res["reason"])
        self.assertFalse((self.corpus / "ada").exists())

    def test_capture_without_a_clip_hash_is_refused(self):
        wd, result = self.make_job("d", segments=[("baseline", 2.0, 0.9)])
        res = ing.capture_corpus(wd, "ada", result, clip_sha256=None,
                                 consent="mine")
        self.assertFalse(res["captured"])
        self.assertIn("clip hash", res["reason"])

    def test_failed_and_dropped_segments_keep_their_label_but_not_their_audio(self):
        wd, result = self.make_job(
            "e", segments=[("baseline", 2.0, 0.9), ("baseline", 1.0, 0.1),
                           ("happy", 1.5, 0.8)],
            failures={1: "classify"}, outliers={2: "dropped"})
        self.assertTrue(ing.capture_corpus(
            wd, "ada", result, clip_sha256="e" * 64, consent="mine")["captured"])
        segs = json.loads((self.corpus / "ada" / ("e" * 64) /
                           "segments.json").read_text("utf-8"))["segments"]
        self.assertEqual(len(segs), 3)             # every label is kept
        self.assertIsNotNone(segs[0]["wav"])
        self.assertIsNone(segs[1]["wav"])          # failed extraction/classify
        self.assertEqual(segs[1]["failure"], "classify")
        self.assertIsNone(segs[2]["wav"])          # measured as another speaker
        self.assertEqual(segs[2]["outlier"], "dropped")

    def test_mismatched_segment_audio_abandons_the_capture(self):
        wd, result = self.make_job("f", segments=[("baseline", 2.0, 0.9)])
        result["segments"][0]["dur"] = 9.0         # label says 9s, wav says 2s
        res = ing.capture_corpus(wd, "ada", result, clip_sha256="f" * 64,
                                 consent="mine")
        self.assertFalse(res["captured"])
        self.assertIn("could not be matched", res["reason"])

    def test_capture_never_raises_on_a_bad_character_id(self):
        wd, result = self.make_job("g", segments=[("baseline", 2.0, 0.9)])
        res = ing.capture_corpus(wd, "../escape", result, clip_sha256="0" * 64,
                                 consent="mine")
        self.assertFalse(res["captured"])
        self.assertIsNotNone(res["reason"])

    def test_a_newer_index_schema_is_refused_rather_than_half_read(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 2.0, 0.9)])
        path = self.corpus / "ada" / ing.CORPUS_INDEX
        idx = json.loads(path.read_text("utf-8"))
        idx["schema"] = ing.CORPUS_SCHEMA + 5
        path.write_text(json.dumps(idx), "utf-8")
        with self.assertRaises(ing.UserFacing) as ctx:
            ing.load_corpus("ada")
        self.assertIn("newer version", str(ctx.exception))


# ── read + delete ─────────────────────────────────────────────────────────────
class ViewAndDeleteTests(CorpusCase):
    def test_view_itemizes_clips_segments_seconds_and_emotions(self):
        self.capture("ada", "a", "1" * 64,
                     segments=[("baseline", 2.0, 0.9), ("happy", 1.5, 0.7)])
        view = ing.corpus_view("ada")
        self.assertEqual(view["totals"]["clips"], 1)
        self.assertEqual(view["totals"]["segments"], 2)
        self.assertGreater(view["totals"]["seconds"], 3.0)
        clip = view["clips"][0]
        self.assertEqual(set(clip["emotions"]), {"baseline", "happy"})
        self.assertEqual(clip["emotions"]["baseline"]["segments"], 1)
        self.assertEqual(clip["consent"]["statement"], "I own this voice.")
        self.assertEqual(len(clip["items"]), 2)
        self.assertEqual(view["cap_bytes"], self.settings.corpus_max_bytes)
        self.assertFalse(view["over_cap"])

    def test_view_of_a_character_with_no_corpus_is_empty_not_an_error(self):
        view = ing.corpus_view("nobody")
        self.assertEqual(view["totals"], {"clips": 0, "segments": 0,
                                          "seconds": 0.0, "bytes": 0})

    def test_delete_removes_every_segment_derived_from_that_clip(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 2.0, 0.9)])
        self.capture("ada", "b", "2" * 64,
                     segments=[("baseline", 2.0, 0.9), ("happy", 1.0, 0.5)])
        report = ing.delete_clip("ada", "2" * 64)
        self.assertEqual(report["removed"]["clip_sha256"], "2" * 64)
        self.assertEqual(report["removed"]["segments"], 2)
        self.assertTrue(report["removed"]["files_deleted"])
        self.assertGreater(report["removed"]["seconds"], 2.0)
        self.assertFalse((self.corpus / "ada" / ("2" * 64)).exists())
        self.assertEqual(report["remaining"]["clips"], 1)
        self.assertEqual([c["clip_sha256"] for c in ing.load_corpus("ada")["clips"]],
                         ["1" * 64])

    def test_delete_of_an_unknown_clip_is_named_not_silent(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 2.0, 0.9)])
        report = ing.delete_clip("ada", "9" * 64)
        self.assertIsNone(report["removed"])
        self.assertIn("no recording", report["reason"])


# ── cap + pruning ─────────────────────────────────────────────────────────────
class CapTests(CorpusCase):
    def test_prune_takes_the_unmeasured_then_lowest_identity_clip_first(self):
        good = {"version": 1, "available": True, "reference_similarity": 0.9,
                "stems": {"baseline": {"identity": 0.9}}}
        poor = {"version": 1, "available": True, "reference_similarity": 0.4,
                "stems": {"baseline": {"identity": 0.4}}}
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 1.0, 0.9)],
                     fidelity=good)
        self.capture("ada", "b", "2" * 64, segments=[("baseline", 1.0, 0.9)],
                     fidelity=poor)
        self.capture("ada", "c", "3" * 64, segments=[("baseline", 1.0, 0.9)])
        total = ing.corpus_bytes(ing.load_corpus("ada"))
        removed = ing.prune_corpus("ada", max_bytes=int(total * 0.5))
        order = [r["clip_sha256"] for r in removed if r["clip_sha256"]]
        # unmeasured first (least evidence), then the lowest measured identity
        self.assertEqual(order[0], "3" * 64)
        self.assertEqual(order[1], "2" * 64)
        self.assertIn("cap", removed[0]["why"])
        self.assertEqual([c["clip_sha256"] for c in ing.load_corpus("ada")["clips"]],
                         ["1" * 64])

    def test_the_last_clip_is_never_pruned_and_the_refusal_is_named(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 1.0, 0.9)])
        removed = ing.prune_corpus("ada", max_bytes=1)
        self.assertEqual(len(ing.load_corpus("ada")["clips"]), 1)
        self.assertIsNone(removed[-1]["clip_sha256"])
        self.assertIn("only one recording remains", removed[-1]["why"])

    def test_capture_prunes_to_the_cap(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 1.0, 0.9)])
        one = ing.corpus_bytes(ing.load_corpus("ada"))
        wd, result = self.make_job("b", segments=[("baseline", 1.0, 0.9)])
        res = ing.capture_corpus(wd, "ada", result, clip_sha256="2" * 64,
                                 consent="mine", max_bytes=int(one * 1.2))
        self.assertTrue(res["captured"])
        self.assertTrue(res["pruned"])
        self.assertEqual(len(ing.load_corpus("ada")["clips"]), 1)


# ── selection + re-derivation ─────────────────────────────────────────────────
class SelectionTests(CorpusCase):
    def test_basis_is_duration_confidence_until_everything_is_measured(self):
        self.capture("ada", "a", "1" * 64,
                     segments=[("baseline", 2.0, 0.9), ("baseline", 1.0, 0.2)])
        sel = ing.select_best("ada", ["baseline"])
        self.assertEqual(sel["report"]["baseline"]["basis"], "duration_confidence")
        self.assertEqual(sel["report"]["baseline"]["segments"], 2)

    def test_basis_is_fidelity_when_every_candidate_is_measured(self):
        fid = {"version": 1, "available": True, "reference_similarity": 0.8,
               "stems": {"baseline": {"identity": 0.8}}}
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 2.0, 0.9)],
                     fidelity=fid)
        sel = ing.select_best("ada", ["baseline"])
        self.assertEqual(sel["report"]["baseline"]["basis"], "fidelity")

    def test_selection_names_an_emotion_the_corpus_has_no_audio_for(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 2.0, 0.9)])
        sel = ing.select_best("ada", ["angry"])
        self.assertEqual(sel["picks"], {})
        self.assertIn("no stored audio", sel["report"]["angry"]["why"])

    def test_a_short_emotion_clears_the_minimum_across_takes(self):
        # 3s of 'happy' in each of two recordings: neither could ever clear the
        # 4s clone minimum alone; the corpus makes one 6s stem out of both.
        self.capture("ada", "a", "1" * 64, segments=[("happy", 3.0, 0.9)])
        self.capture("ada", "b", "2" * 64, segments=[("happy", 3.0, 0.9)])
        sel = ing.select_best("ada", ["happy"])
        self.assertEqual(sel["report"]["happy"]["segments"], 2)
        self.assertGreaterEqual(sel["report"]["happy"]["seconds"],
                                ing.MIN_STEM_SECONDS)
        self.assertEqual(len(sel["report"]["happy"]["clips"]), 2)
        # …and the spliced stem on disk really is over the bar.
        out = self.root / "rebuild"
        out.mkdir()
        sp = ing.concat_wavs([Path(r["wav"]) for r in sel["picks"]["happy"]],
                             out / "stem_happy.wav")
        self.assertGreaterEqual(sp.seconds, ing.MIN_STEM_SECONDS)


class RederiveTests(CorpusCase):
    def _rebuild(self, cid: str, emotions=None) -> dict:
        wd = self.root / f"rederive-{uuid_ish()}"
        _FakeExportPopen.spawned = 0
        with mock.patch.object(ing.subprocess, "Popen", _FakeExportPopen):
            return ing.rederive(cid, wd, emotions)

    def test_rederive_rebuilds_and_stamps_provenance(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 3.0, 0.9)])
        self.capture("ada", "b", "2" * 64, segments=[("baseline", 3.0, 0.9)])
        res = self._rebuild("ada")
        self.assertEqual([c["emotion"] for c in res["created"]], ["baseline"])
        meta = json.loads((self.voices / "_meta.json").read_text("utf-8"))
        entry = next(iter(meta["voices"].values()))
        self.assertEqual(entry["source"], "rederive")
        prov = entry["derived_from"]
        self.assertEqual(prov["corpus_rev"], ing.load_corpus("ada")["rev"])
        self.assertEqual(prov["dsp_version"], ing.DSP_VERSION)
        self.assertIn("pocket-tts", prov["model_version"])
        self.assertEqual(sorted(prov["clips"]), ["1" * 64, "2" * 64])
        # consent travels forward from the corpus — no new attestation asked for
        self.assertEqual(entry["consent"]["statement"], "I own this voice.")

    def test_rederive_replaces_the_existing_voice_in_that_slot(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 5.0, 0.9)])
        first = self._rebuild("ada")
        old_id = first["created"][0]["voice_id"]
        self.assertTrue((self.voices / f"{old_id}.safetensors").is_file())
        second = self._rebuild("ada")
        new_id = second["created"][0]["voice_id"]
        self.assertNotEqual(old_id, new_id)
        self.assertEqual(second["created"][0]["replaced"], old_id)
        meta = json.loads((self.voices / "_meta.json").read_text("utf-8"))
        self.assertEqual(list(meta["voices"]), [new_id])       # ONE row per slot
        self.assertFalse((self.voices / f"{old_id}.safetensors").is_file())

    def test_rederive_without_a_corpus_is_a_named_refusal(self):
        with self.assertRaises(ing.UserFacing) as ctx:
            self._rebuild("ghost")
        self.assertIn("no corpus", str(ctx.exception))

    def test_rederive_with_an_empty_selection_is_a_named_refusal(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 3.0, 0.9)])
        with self.assertRaises(ing.UserFacing) as ctx:
            self._rebuild("ada", ["angry"])
        self.assertIn("nothing to rebuild", str(ctx.exception))

    def test_rederive_over_the_byte_cap_is_a_named_refusal(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 3.0, 0.9)])
        with mock.patch.object(
                ing, "SETTINGS",
                dataclasses.replace(self.settings, corpus_max_bytes=1)):
            with self.assertRaises(ing.UserFacing) as ctx:
                self._rebuild("ada")
        self.assertIn("over its", str(ctx.exception))


_counter = {"n": 0}


def uuid_ish() -> str:
    _counter["n"] += 1
    return str(_counter["n"])


# ── HTTP surface ──────────────────────────────────────────────────────────────
class CorpusApiTests(CorpusCase):
    def setUp(self) -> None:
        super().setUp()
        self.client = TestClient(appmod.app, raise_server_exceptions=False)
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)
        super().tearDown()

    def test_get_corpus_itemizes_and_delete_removes(self):
        self.capture("ada", "a", "1" * 64,
                     segments=[("baseline", 2.0, 0.9), ("happy", 1.0, 0.6)])
        r = self.client.get("/v1/characters/ada/corpus")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["totals"]["clips"], 1)
        self.assertEqual(body["clips"][0]["clip_sha256"], "1" * 64)

        d = self.client.delete(f"/v1/characters/ada/corpus/{'1' * 64}")
        self.assertEqual(d.status_code, 200)
        self.assertEqual(d.json()["removed"]["segments"], 2)
        self.assertEqual(
            self.client.get("/v1/characters/ada/corpus").json()["totals"]["clips"], 0)

    def test_delete_of_an_unknown_clip_is_404(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 2.0, 0.9)])
        r = self.client.delete(f"/v1/characters/ada/corpus/{'7' * 64}")
        self.assertEqual(r.status_code, 404)

    def test_a_hostile_character_id_is_rejected_not_sanitised(self):
        r = self.client.get("/v1/characters/..%2F..%2Fetc/corpus")
        self.assertIn(r.status_code, (400, 404))

    def test_rederive_refuses_a_character_with_no_corpus(self):
        r = self.client.post("/v1/ingest/rederive", json={"character_id": "ghost"})
        self.assertEqual(r.status_code, 404)
        self.assertIn("no corpus", r.json()["detail"])

    def test_rederive_refuses_an_emotion_the_corpus_cannot_serve(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 3.0, 0.9)])
        r = self.client.post("/v1/ingest/rederive",
                             json={"character_id": "ada", "emotions": ["angry"]})
        self.assertEqual(r.status_code, 409)

    def test_rederive_refuses_an_over_cap_corpus(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 3.0, 0.9)])
        with mock.patch.object(
                ingest_api, "SETTINGS",
                dataclasses.replace(self.settings, corpus_max_bytes=1)):
            r = self.client.post("/v1/ingest/rederive",
                                 json={"character_id": "ada"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("over its", r.json()["detail"])

    def test_rederive_starts_a_pollable_job(self):
        self.capture("ada", "a", "1" * 64, segments=[("baseline", 5.0, 0.9)])
        with mock.patch.object(ingest_api.threading, "Thread") as thread:
            r = self.client.post("/v1/ingest/rederive", json={"character_id": "ada"})
            self.assertTrue(thread.called)
        self.assertEqual(r.status_code, 200)
        job_id = r.json()["job_id"]
        self.assertEqual(r.json()["selection"]["baseline"]["segments"], 1)
        got = self.client.get(f"/v1/ingest/{job_id}").json()
        self.assertEqual(got["mode"], "rederive")
        self.assertEqual(got["status"], "committing")
        self.assertIn("never adds to it", got["corpus"]["reason"])


class CommitCaptureTests(CorpusCase):
    """The opt-in, end to end through the commit phase."""

    def _job(self, jid: str, *, corpus: bool) -> dict:
        wd, result = self.make_job(jid, segments=[("baseline", 5.0, 0.9)],
                                   stem_seconds={"baseline": 5.0})
        job = {"id": jid, "status": "committing", "step": None, "mode": "sovereign",
               "steps": [{**s, "state": "pending"}
                         for s in ingest_api.STEPS_BY_MODE["sovereign"]],
               "partial": {}, "speakers": None, "duration": 0, "result": result,
               "error": None, "note": None, "limits": None,
               "detection": {"threshold_db": -41.0},
               "work_dir": str(wd), "created": time.time(),
               "clip_sha256": jid * 8, "cancel": False, "committed": None,
               "recipes": None, "recipe_plan": {},
               "corpus": {"requested": corpus, "captured": False, "reason": None}}
        ingest_api.JOBS[jid] = job
        return job

    def setUp(self) -> None:
        super().setUp()
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)
        super().tearDown()

    def test_commit_with_corpus_on_captures_after_a_successful_clone(self):
        job = self._job("aaaaaaaa", corpus=True)
        with mock.patch.object(ing.subprocess, "Popen", _FakeExportPopen):
            ingest_api._do_commit("aaaaaaaa", "Ada", ["baseline"], None,
                                  "I own this voice.", None, True)
        self.assertEqual(job["status"], "committed")
        self.assertTrue(job["corpus"]["captured"], job["corpus"])
        idx = ing.load_corpus("ada")
        self.assertEqual(len(idx["clips"]), 1)
        self.assertEqual(idx["clips"][0]["consent"]["statement"], "I own this voice.")

    def test_commit_defaults_to_keeping_nothing(self):
        self._job("bbbbbbbb", corpus=False)
        with mock.patch.object(ing.subprocess, "Popen", _FakeExportPopen):
            ingest_api._do_commit("bbbbbbbb", "Bea", ["baseline"], None,
                                  "I own this voice.", None, False)
        self.assertFalse((self.corpus / "bea").exists())
        self.assertEqual(ing.corpus_view("bea")["totals"]["clips"], 0)

    def test_a_commit_that_created_nothing_captures_nothing(self):
        job = self._job("cccccccc", corpus=True)
        with mock.patch.object(ingest_api.ingest, "commit", return_value=[]):
            ingest_api._do_commit("cccccccc", "Cai", ["baseline"], None,
                                  "I own this voice.", None, True)
        self.assertFalse(job["corpus"]["captured"])
        self.assertIn("created no voices", job["corpus"]["reason"])


if __name__ == "__main__":
    unittest.main()
