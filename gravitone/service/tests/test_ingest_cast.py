"""One video, many characters — the cast.

`analyze` already computes per-speaker stats and a preview for EVERY speaker in
a recording, and its two paid calls (Scribe, the Isolator) produce exactly two
durable artifacts: `clean.wav` and `segments.json`, both about the WHOLE
recording. The narrowing to one speaker was product, not pipeline. These tests
pin the claim that makes casting N defensible and the honesty it owes:

  * the fan-out re-reads those artifacts and NEVER re-invokes a paid provider;
  * one JOB, one admission slot, one `Spend` — the per-job budgets bound the
    whole cast, and a cast that hits the escalation cap SAYS so;
  * a member that fails is rolled back and named while its siblings keep their
    Characters (no all-or-nothing lie, no silent drop);
  * every Character carries the same consent receipt + provenance a
    single-speaker commit writes, including the link-sourced attestation rule;
  * the scene hand-off maps the transcript's lines onto what was cast.

Everything below runs with ffmpeg, the classifier and the export child mocked.
"""
from __future__ import annotations

import io
import json
import time
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi import HTTPException

from service import ingest, ingest_api
from service import voices as vc


# ── fixtures ──────────────────────────────────────────────────────────────────
def _write_wav(path: Path, frames: int = 24000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x01" * frames)


class _FakeExportPopen:
    """The one-load export child: writes each stem's dst and streams a status
    line per stem, exactly as `service.export_stems` does."""

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


def _segments(n_each: int = 6) -> list[dict]:
    """A two-speaker conversation, alternating, with real text (cloud mode)."""
    segs: list[dict] = []
    t = 0.0
    for i in range(n_each):
        for sid in ("speaker_0", "speaker_1"):
            segs.append({"speaker": sid, "start": t, "end": t + 2.0,
                         "text": f"{sid} line {i}"})
            t += 2.0
    return segs


def _analyzed(root: Path) -> Path:
    """A job workdir in exactly the state `analyze` leaves it in."""
    wd = root / "job"
    wd.mkdir(parents=True, exist_ok=True)
    _write_wav(wd / "clean.wav", 24000 * 30)
    (wd / "segments.json").write_text(json.dumps(_segments()), "utf-8")
    for sid in ("speaker_0", "speaker_1"):
        _write_wav(wd / f"speaker_{sid}.wav", 24000 * 2)
    return wd


def _job(wd: Path, jid: str = "j1", *, source: dict | None = None,
         status: str = "awaiting_speaker") -> dict:
    job = ingest_api._new_job(jid, wd, "cloud", "deadbeef", False,
                              source or ingest_api.UPLOAD_SOURCE)
    job["status"] = status
    job["speakers"] = [{"id": "speaker_0", "utterances": 6, "seconds": 12.0,
                        "sample_text": "hello"},
                       {"id": "speaker_1", "utterances": 6, "seconds": 12.0,
                        "sample_text": "hi"}]
    return job


def _members(*pairs: tuple[str, str]) -> list[dict]:
    return [{"speaker_id": sid, "character": name, "character_id": None,
             "status": "pending", "error": None, "voices": []}
            for sid, name in pairs]


class _CastHarness(unittest.TestCase):
    """Runs `_do_cast` synchronously with every subprocess mocked."""

    def setUp(self) -> None:
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()
        ingest_api._SPEND.clear()
        _FakeExportPopen.spawned = 0

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)
        ingest_api._SPEND.clear()

    def run_cast(self, root: Path, members: list[dict], *,
                 job: dict | None = None,
                 commit_side_effect=None,
                 statement: str = "I own this voice.") -> dict:
        # A caller that built its own job (and its own segments) keeps them.
        job = job or _job(_analyzed(root))
        job["cast"] = {"members": members, "done": 0, "failed": 0,
                       "abandoned": False, "spend": None, "budget_note": None}
        job["status"] = "casting"
        ingest_api.JOBS[job["id"]] = job

        def fake_label(wav_paths, spend=None):
            # One classifier request per batch, charged to the JOB's ledger.
            if spend is not None:
                spend.charge("gemini")
            return [{"emotion": "happy" if i % 2 else ingest.BASELINE,
                     "confidence": 0.9, "cue": "c", "model": "flash"}
                    for i, _ in enumerate(wav_paths)]

        def fake_extract(src, dst, a=None, b=None) -> None:
            # The extracted wav is as long as the span asked for, so stem
            # eligibility in these tests is decided by the segments, as it is
            # in production.
            span = 1.0 if a is None or b is None else max(0.05, float(b) - float(a))
            _write_wav(Path(dst), int(24000 * span))

        voices_root = root / "voices"
        voices_root.mkdir(parents=True, exist_ok=True)
        patches = [
            mock.patch.object(ingest, "to_wav", side_effect=fake_extract),
            mock.patch.object(ingest, "label_emotions", side_effect=fake_label),
            # The two paid calls. If the fan-out ever reaches for one of these,
            # the whole claim of this feature is false — so they EXPLODE.
            mock.patch.object(ingest, "scribe",
                              side_effect=AssertionError("scribe re-invoked")),
            mock.patch.object(ingest, "voice_isolate",
                              side_effect=AssertionError("isolator re-invoked")),
            mock.patch.object(ingest, "VOICES_DIR", voices_root),
            mock.patch.object(vc, "VOICES_DIR", voices_root),
            mock.patch.object(vc, "META_PATH", voices_root / "_meta.json"),
            mock.patch.object(ingest.subprocess, "Popen", _FakeExportPopen),
        ]
        if commit_side_effect is not None:
            patches.append(mock.patch.object(ingest, "commit",
                                             side_effect=commit_side_effect))
        for p in patches:
            p.start()
        try:
            ingest_api._do_cast(job["id"], statement)
        finally:
            for p in reversed(patches):
                p.stop()
        return job


# ── the claim: no second paid call ────────────────────────────────────────────
class FanOutReusesTheScanTests(_CastHarness):
    def test_two_characters_from_one_scan_without_a_second_paid_call(self) -> None:
        with TemporaryDirectory() as td:
            job = self.run_cast(Path(td), _members(("speaker_0", "Ada"),
                                                   ("speaker_1", "Bo")))
        # Both mocks would have raised AssertionError inside the phase; the
        # phase catches per member, so assert the OUTCOME as well as the mocks.
        members = job["cast"]["members"]
        self.assertEqual([m["status"] for m in members], ["done", "done"])
        self.assertEqual([m["character_id"] for m in members], ["ada", "bo"])
        for m in members:
            self.assertTrue(m["voices"], m.get("error"))
        self.assertEqual(job["status"], "committed")
        self.assertEqual(job["cast"]["done"], 2)
        self.assertEqual(job["cast"]["failed"], 0)
        # `committed` is the flattened truth the existing studio screen reads.
        self.assertEqual(len(job["committed"]),
                         sum(len(m["voices"]) for m in members))

    def test_the_scan_artifacts_are_read_not_rebuilt(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            job = self.run_cast(root, _members(("speaker_0", "Ada"),
                                               ("speaker_1", "Bo")))
            wd = Path(job["work_dir"])
            # clean.wav / segments.json stayed put; each member cut into its own
            # room, so no member overwrote another's segments or stems.
            self.assertTrue((wd / "clean.wav").is_file())
            self.assertTrue((wd / "segments.json").is_file())
            for sid in ("speaker_0", "speaker_1"):
                sub = wd / f"cast_{sid}"
                self.assertTrue((sub / "stem_baseline.wav").is_file())
                self.assertTrue(any(sub.glob("seg_*.wav")))

    def test_the_whole_cast_shares_one_spend_ledger(self) -> None:
        """The budget bounds the JOB, not each speaker — which is only true if
        both members charge the same ledger."""
        with TemporaryDirectory() as td:
            job = self.run_cast(Path(td), _members(("speaker_0", "Ada"),
                                                   ("speaker_1", "Bo")))
        ledger = ingest_api._SPEND[job["id"]]
        snap = job["cast"]["spend"]
        self.assertEqual(snap["total_calls"], ledger.snapshot()["total_calls"])
        # Both speakers were labelled, so the shared ledger counted more calls
        # than either member could have made alone.
        self.assertGreaterEqual(snap["calls"].get("gemini", 0), 2)
        # ...and it is the ONE ledger the job already had, not a fresh budget.
        self.assertIs(ingest_api._spend_for(job["id"]), ledger)

    def test_sovereign_cast_is_baseline_only_and_costs_nothing(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            wd = _analyzed(root)
            job = _job(wd, "sov")
            job["mode"] = "sovereign"
            job = self.run_cast(root, _members(("speaker_0", "Ada"),
                                               ("speaker_1", "Bo")), job=job)
        members = job["cast"]["members"]
        self.assertEqual([m["status"] for m in members], ["done", "done"])
        for m in members:
            self.assertEqual({v["emotion"] for v in m["voices"]},
                             {ingest.BASELINE})
        self.assertEqual(job["cast"]["spend"]["total_calls"], 0)


# ── honesty: partial failure, budgets, receipts ───────────────────────────────
class PartialFailureTests(_CastHarness):
    def test_a_failed_member_is_rolled_back_and_named_the_others_survive(self) -> None:
        real_commit = ingest.commit
        removed: list[list[str]] = []

        def flaky(work_dir, character, emotions, cid=None, **kw):
            if character == "Bo":
                # Register one voice, THEN fail — the half-Character case.
                on_voice = kw.get("on_voice")
                if on_voice:
                    on_voice({"voice_id": "bo-happy-xyz", "emotion": "happy"})
                raise RuntimeError("pocket_tts died: /tmp/secret/path")
            return real_commit(work_dir, character, emotions, cid, **kw)

        with TemporaryDirectory() as td:
            with mock.patch.object(ingest_api.voices, "remove_voices",
                                   side_effect=lambda ids: removed.append(list(ids)) or list(ids)):
                job = self.run_cast(Path(td),
                                    _members(("speaker_0", "Ada"), ("speaker_1", "Bo")),
                                    commit_side_effect=flaky)
        ada, bo = job["cast"]["members"]
        self.assertEqual(ada["status"], "done")
        self.assertTrue(ada["voices"])
        self.assertEqual(bo["status"], "error")
        self.assertEqual(bo["voices"], [])
        self.assertTrue(bo["error"])
        # Sanitized: the raw subprocess text never reaches the client.
        self.assertNotIn("/tmp/secret/path", bo["error"])
        # The half-Character was undone, and only that member's ids.
        self.assertEqual(removed, [["bo-happy-xyz"]])
        # The cast as a whole is NOT a failure: one character exists.
        self.assertEqual(job["status"], "committed")
        self.assertEqual((job["cast"]["done"], job["cast"]["failed"]), (1, 1))

    def test_every_member_failing_ends_the_job_in_error(self) -> None:
        def always_fail(*a, **kw):
            raise RuntimeError("nope")

        with TemporaryDirectory() as td:
            job = self.run_cast(Path(td), _members(("speaker_0", "Ada")),
                                commit_side_effect=always_fail)
        self.assertEqual(job["status"], "error")
        self.assertTrue(job["error"])
        self.assertEqual(job["cast"]["members"][0]["status"], "error")

    def test_a_speaker_with_too_little_audio_says_so(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            wd = _analyzed(root)
            # speaker_1 says one very short thing.
            segs = [s for s in _segments() if s["speaker"] == "speaker_0"]
            segs.append({"speaker": "speaker_1", "start": 100.0, "end": 100.5,
                         "text": "hm"})
            (wd / "segments.json").write_text(json.dumps(segs), "utf-8")
            job = _job(wd)
            job["cast"] = None
            job = self.run_cast(root, _members(("speaker_1", "Bo")), job=job)
        member = job["cast"]["members"][0]
        self.assertEqual(member["status"], "error")
        self.assertIn("minimum", member["error"])

    def test_the_budget_note_states_a_cap_that_was_reached(self) -> None:
        self.assertIsNone(ingest_api._cast_budget_note(
            {"escalations_skipped": 0, "retries": 0, "retry_budget": 8}))
        note = ingest_api._cast_budget_note(
            {"escalations_skipped": 5, "retries": 8, "retry_budget": 8})
        self.assertIn("5 uncertain clip", note)
        self.assertIn("still cast", note)
        self.assertIn("retry budget", note)


class ReceiptTests(_CastHarness):
    def test_every_cast_character_carries_the_consent_receipt(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            job = self.run_cast(root, _members(("speaker_0", "Ada"),
                                               ("speaker_1", "Bo")),
                                statement="I own this voice.")
            meta = json.loads((root / "voices" / "_meta.json").read_text("utf-8"))
        self.assertEqual(set(meta["characters"]), {"ada", "bo"})
        self.assertTrue(meta["voices"])
        for entry in meta["voices"].values():
            self.assertEqual(entry["consent"]["statement"], "I own this voice.")
            self.assertEqual(entry["consent"]["clip_sha256"], "deadbeef")
            self.assertEqual(entry["source"], "ingest")
            self.assertIn("consented_at", entry["consent"])

    def test_a_link_job_demands_the_external_statement_for_the_whole_cast(self) -> None:
        from service import ingest_url
        with TemporaryDirectory() as td:
            wd = _analyzed(Path(td))
            job = _job(wd, "lnk", source={"kind": "url", "url": "https://y/t?v=1",
                                          "title": "t", "trimmed": False})
            with self.assertRaises(HTTPException) as ctx:
                ingest_api._attestation(job, True, "I own this voice.")
            self.assertEqual(ctx.exception.status_code, 422)
            stamped = ingest_api._attestation(
                job, True, ingest_url.EXTERNAL_STATEMENT)
            # ONE attestation covers the cast, and it names the recording.
            self.assertTrue(stamped.startswith(ingest_url.EXTERNAL_STATEMENT))
            self.assertIn("https://y/t?v=1", stamped)

    def test_no_attestation_is_still_a_422(self) -> None:
        with TemporaryDirectory() as td:
            job = _job(_analyzed(Path(td)))
            for attested, statement in ((False, "I own this voice."), (True, "  ")):
                with self.assertRaises(HTTPException) as ctx:
                    ingest_api._attestation(job, attested, statement)
                self.assertEqual(ctx.exception.status_code, 422)


# ── the route: validation, 409 coherence, admission ───────────────────────────
class CastRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()
        self._td = TemporaryDirectory()
        self.wd = _analyzed(Path(self._td.name))
        self.job = _job(self.wd)
        ingest_api.JOBS["j1"] = self.job
        self._spawn = mock.patch.object(ingest_api, "_spawn")
        self.spawn = self._spawn.start()

    def tearDown(self) -> None:
        self._spawn.stop()
        self._td.cleanup()
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)

    def _req(self, *pairs: tuple[str, str], **kw) -> ingest_api.CastReq:
        return ingest_api.CastReq(
            members=[{"speaker_id": s, "character": n} for s, n in pairs],
            attested=kw.get("attested", True),
            statement=kw.get("statement", "I own this voice."))

    def _refusal(self, req) -> HTTPException:
        with self.assertRaises(HTTPException) as ctx:
            ingest_api.cast("j1", req)
        return ctx.exception

    def test_a_cast_starts_one_phase_for_the_whole_selection(self) -> None:
        out = ingest_api.cast("j1", self._req(("speaker_0", "Ada"),
                                              ("speaker_1", "Bo")))
        self.assertEqual(out, {"status": "casting", "members": 2})
        self.assertEqual(self.job["status"], "casting")
        self.assertEqual(self.spawn.call_count, 1)   # ONE thread, not N
        self.assertEqual([m["status"] for m in self.job["cast"]["members"]],
                         ["pending", "pending"])

    def test_casting_a_single_speaker_is_allowed(self) -> None:
        self.assertEqual(ingest_api.cast("j1", self._req(("speaker_0", "Ada"))),
                         {"status": "casting", "members": 1})

    def test_the_two_exits_share_one_409(self) -> None:
        ingest_api.cast("j1", self._req(("speaker_0", "Ada")))
        with self.assertRaises(HTTPException) as ctx:
            ingest_api.choose_speaker("j1", ingest_api.SpeakerReq(speaker_id="speaker_1"))
        self.assertEqual(ctx.exception.status_code, 409)

    def test_choosing_a_speaker_first_refuses_a_later_cast(self) -> None:
        ingest_api.choose_speaker("j1", ingest_api.SpeakerReq(speaker_id="speaker_0"))
        self.assertEqual(self._refusal(self._req(("speaker_1", "Bo"))).status_code, 409)

    def test_refusals_are_named(self) -> None:
        self.assertEqual(self._refusal(self._req()).status_code, 400)
        self.assertIn("at most", self._refusal(self._req(
            *[(f"speaker_{i}", f"N{i}") for i in range(ingest_api.MAX_CAST_MEMBERS + 1)]
        )).detail)
        self.assertIn("twice", self._refusal(self._req(
            ("speaker_0", "Ada"), ("speaker_0", "Bo"))).detail)
        self.assertIn("same character", self._refusal(self._req(
            ("speaker_0", "Ada"), ("speaker_1", "ada"))).detail)
        self.assertIn("not a speaker", self._refusal(self._req(
            ("speaker_9", "Zed"))).detail)
        self.assertEqual(self._refusal(self._req(("speaker_0", "  "))).status_code, 400)
        self.assertEqual(
            self._refusal(self._req(("speaker_0", "Ada"), attested=False)).status_code,
            422)

    def test_a_speaker_id_can_never_reach_a_path(self) -> None:
        for bad in ("../../etc", "a/b", "", "." * 41):
            with self.assertRaises(HTTPException):
                ingest_api._valid_speaker_id(bad)
        self.assertEqual(
            ingest_api._member_dir(Path("/w"), "speaker_1").name, "cast_speaker_1")


class AccountingTests(unittest.TestCase):
    """One job even while casting N — admission and GC both have to agree."""

    def test_a_cast_is_one_active_job(self) -> None:
        self.assertIn("casting", ingest_api.ACTIVE_STATUSES)
        jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()
        try:
            ingest_api.JOBS["a"] = {"status": "casting"}
            self.assertEqual(ingest_api._active_count(), 1)
        finally:
            ingest_api.JOBS.clear()
            ingest_api.JOBS.update(jobs)

    def test_a_running_cast_is_not_reaped_on_the_idle_ttl(self) -> None:
        now = time.time()
        # Older than the idle TTL, younger than the wedged one: a three-member
        # cast is three clone phases, and the idle TTL would delete the workdir
        # out from under the thread half way through.
        mid = {"status": "casting", "touched": now - ingest_api._TTL - 60,
               "created": now - ingest_api._TTL - 60}
        self.assertFalse(ingest_api._is_expired(mid, now))
        wedged = dict(mid, touched=now - ingest_api._RUNNING_TTL - 60,
                      created=now - ingest_api._RUNNING_TTL - 60)
        self.assertTrue(ingest_api._is_expired(wedged, now))


class ReconcileTests(unittest.TestCase):
    """A restart mid-cast keeps the finished Characters and undoes the half one."""

    def _run(self, journal: dict) -> tuple[dict, list]:
        removed: list = []
        with TemporaryDirectory() as td:
            wd = Path(td)
            ingest_api._write_journal(wd, journal)
            job = {"id": "j", "status": "casting"}
            with mock.patch.object(ingest_api.voices, "remove_voices",
                                   side_effect=lambda ids: removed.append(list(ids)) or list(ids)):
                ingest_api._reconcile(job, wd)
            self.assertFalse((wd / ingest_api._JOURNAL_NAME).exists())
        return job, removed

    def test_finished_members_are_kept_and_the_half_one_is_undone(self) -> None:
        job, removed = self._run({
            "kind": "cast", "state": "running", "members": [
                {"speaker_id": "speaker_0", "character": "Ada", "state": "done",
                 "registered": [{"voice_id": "ada-baseline-1", "emotion": "baseline"}]},
                {"speaker_id": "speaker_1", "character": "Bo", "state": "cloning",
                 "registered": [{"voice_id": "bo-baseline-2", "emotion": "baseline"}]},
            ]})
        self.assertEqual(job["status"], "error")
        self.assertIn("KEPT", job["error"])
        self.assertEqual([v["voice_id"] for v in job["committed"]], ["ada-baseline-1"])
        self.assertEqual(removed, [["bo-baseline-2"]])

    def test_a_cast_that_had_finished_is_marked_committed(self) -> None:
        job, removed = self._run({
            "kind": "cast", "state": "done", "members": [
                {"speaker_id": "speaker_0", "character": "Ada", "state": "done",
                 "registered": [{"voice_id": "ada-baseline-1", "emotion": "baseline"}]},
            ]})
        self.assertEqual(job["status"], "committed")
        self.assertEqual(removed, [])


# ── the scene hand-off ────────────────────────────────────────────────────────
class SceneTests(unittest.TestCase):
    def test_consecutive_same_speaker_segments_become_one_line(self) -> None:
        segs = [{"speaker": "s0", "text": "Hello there."},
                {"speaker": "s0", "text": "How are you?"},
                {"speaker": "s1", "text": "Fine."},
                {"speaker": "s0", "text": "Good."}]
        out = ingest_api.build_scene(segs, {"s0": "ada", "s1": "bo"})
        self.assertEqual([l["text"] for l in out["lines"]],
                         ["Hello there. How are you?", "Fine.", "Good."])
        self.assertEqual([l["character_id"] for l in out["lines"]],
                         ["ada", "bo", "ada"])
        self.assertFalse(out["truncated"])
        self.assertEqual(out["omitted"], [])

    def test_uncast_speakers_are_omitted_and_counted(self) -> None:
        segs = [{"speaker": "s0", "text": "a"}, {"speaker": "s2", "text": "b"},
                {"speaker": "s2", "text": "c"}, {"speaker": "s0", "text": "d"}]
        out = ingest_api.build_scene(segs, {"s0": "ada"})
        # The omitted speaker does not merge the lines around it either.
        self.assertEqual([l["text"] for l in out["lines"]], ["a", "d"])
        self.assertEqual(out["omitted"], [{"speaker": "s2", "segments": 2}])

    def test_the_line_cap_truncates_and_says_so(self) -> None:
        segs = [{"speaker": "s0" if i % 2 else "s1", "text": f"l{i}"}
                for i in range(ingest_api.MAX_SCENE_LINES * 2)]
        out = ingest_api.build_scene(segs, {"s0": "ada", "s1": "bo"})
        self.assertEqual(len(out["lines"]), ingest_api.MAX_SCENE_LINES)
        self.assertTrue(out["truncated"])
        self.assertEqual(out["total_lines"], ingest_api.MAX_SCENE_LINES * 2)

    def test_empty_text_segments_produce_nothing(self) -> None:
        out = ingest_api.build_scene(
            [{"speaker": "s0", "text": ""}, {"speaker": "s0", "text": "   "}],
            {"s0": "ada"})
        self.assertEqual(out["lines"], [])


class SceneRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()
        self._td = TemporaryDirectory()
        self.wd = _analyzed(Path(self._td.name))
        self.job = _job(self.wd, "j1", status="committed")
        self.job["cast"] = {"members": [
            {"speaker_id": "speaker_0", "character": "Ada", "character_id": "ada",
             "status": "done", "voices": [{"voice_id": "v1", "emotion": "baseline"}]},
            {"speaker_id": "speaker_1", "character": "Bo", "character_id": "bo",
             "status": "error", "error": "too short", "voices": []},
        ], "done": 1, "failed": 1}
        ingest_api.JOBS["j1"] = self.job

    def tearDown(self) -> None:
        self._td.cleanup()
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)

    def test_only_speakers_that_became_characters_get_lines(self) -> None:
        out = ingest_api.scene("j1")
        self.assertTrue(out["available"])
        self.assertTrue(out["lines"])
        self.assertEqual({l["character_id"] for l in out["lines"]}, {"ada"})
        self.assertEqual(out["omitted"], [{"speaker": "speaker_1", "segments": 6}])
        self.assertEqual(out["names"], {"ada": "Ada"})

    def test_a_transcriptless_scan_explains_itself(self) -> None:
        segs = [dict(s, text="") for s in _segments()]
        (self.wd / "segments.json").write_text(json.dumps(segs), "utf-8")
        self.job["mode"] = "sovereign"
        out = ingest_api.scene("j1")
        self.assertFalse(out["available"])
        self.assertIn("sovereign", out["reason"])

    def test_a_swept_workdir_explains_itself(self) -> None:
        (self.wd / "segments.json").unlink()
        out = ingest_api.scene("j1")
        self.assertFalse(out["available"])
        self.assertIn("cleaned up", out["reason"])

    def test_a_job_that_was_never_cast_has_no_scene(self) -> None:
        self.job["cast"] = None
        out = ingest_api.scene("j1")
        self.assertFalse(out["available"])
        self.assertIn("no character was cast", out["reason"])


if __name__ == "__main__":
    unittest.main()
