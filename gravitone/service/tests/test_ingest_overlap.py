"""A scan stops waiting on itself.

Two costs were being paid for nothing.

THE PAID CALLS RAN IN A LINE. `analyze` called Scribe (minutes, 300s timeout)
and then the Isolator (minutes, 300s timeout) — two independent HTTP requests
against the same uploaded file, neither consuming the other's output — strictly
one after the other. They now overlap.

THE SEGMENTS WERE RE-MEASURED. `segment_rows` opens every segment wav for its
duration and `_variants` runs `ingest.measure_levels` (a full frame-RMS decode)
over every candidate, and the flow calls them again and again: once building the
recipes, once building the casting board, once more per debounced /stems, and
the whole thing over again on a reset. A per-job memo makes each measurement
happen once.

WHAT IS PROVEN HERE
-------------------
* the two calls really are IN FLIGHT AT ONCE (an occupancy counter on the fakes,
  which reads 1 for the old serial code and 2 for this one);
* the ledger stays honest when one of them fails — the other's spend is not lost
  — and the user-visible error is the one today's code produces;
* the pass counts: three `segment_rows` traversals decode the audio ONCE, not
  three times, and the answers are byte-identical to the un-memoized ones;
* the memo re-measures a file whose bytes changed, and is dropped with the job;
* the sovereign path is untouched — no network call, no second thread.

Everything external is mocked (no ElevenLabs, no Gemini, no ffmpeg on the
overlap tests); the memo tests use real wavs and the real measurement code,
because counting decodes of fake audio would prove nothing.
"""
from __future__ import annotations

import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import service.ingest as ingest
import service.ingest_api as ingest_api
from service.tests.test_casting import _Scan, write_wav


class _Occupancy:
    """How many of the fakes were inside their call at the same moment."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.now = 0
        self.peak = 0
        self.order: list[str] = []

    def enter(self, who: str) -> None:
        with self.lock:
            self.now += 1
            self.peak = max(self.peak, self.now)
            self.order.append(who)

    def leave(self) -> None:
        with self.lock:
            self.now -= 1


class OverlappedAnalyzeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.wd = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)
        self.keys = [mock.patch.object(ingest, "ELEVEN_KEY", "k"),
                     mock.patch.object(ingest, "GEMINI_KEY", "k")]
        for p in self.keys:
            p.start()
            self.addCleanup(p.stop)

    def _transcript(self) -> dict:
        return {"words": [{"type": "word", "text": "hi", "start": 0.0, "end": 0.4,
                           "speaker_id": "speaker_0"},
                          {"type": "word", "text": "there", "start": 0.5,
                           "end": 2.0, "speaker_id": "speaker_0"}],
                "audio_duration_secs": 3, "text": "hi there"}

    def test_the_two_paid_calls_are_in_flight_together(self) -> None:
        """The whole optimization, measured: peak occupancy 2, not 1.

        Both fakes hold their call open until the other has entered, with a
        timeout — so the SERIAL code cannot pass this test by being fast, it
        deadlocks its way to a peak of 1 and fails the assertion.
        """
        occ = _Occupancy()
        both_in = threading.Barrier(2, timeout=5)

        def fake_scribe(path, spend=None):
            occ.enter("scribe")
            try:
                both_in.wait()
            except threading.BrokenBarrierError:
                pass
            occ.leave()
            return self._transcript()

        def fake_isolate(path, dst, spend=None):
            occ.enter("isolate")
            try:
                both_in.wait()
            except threading.BrokenBarrierError:
                pass
            occ.leave()

        with mock.patch.object(ingest, "scribe", side_effect=fake_scribe), \
             mock.patch.object(ingest, "voice_isolate", side_effect=fake_isolate), \
             mock.patch.object(ingest, "clean_audio",
                               side_effect=lambda src, dst, sr=24000: write_wav(Path(dst), 3.0)), \
             mock.patch.object(ingest, "to_wav",
                               side_effect=lambda src, dst, a=None, b=None: write_wav(Path(dst), 1.0)):
            res = ingest.analyze(self.wd / "in.wav", self.wd)

        self.assertEqual(occ.peak, 2, "the paid calls did not overlap")
        self.assertEqual(sorted(occ.order), ["isolate", "scribe"])
        self.assertEqual([s["id"] for s in res["speakers"]], ["speaker_0"])

    def test_both_steps_report_active_before_either_finishes(self) -> None:
        """No invented sequence: the reporting says both are running, because
        both are. The step keys are unchanged (the studio loader keys off
        them) — what changed is that they are concurrent."""
        seen: list[tuple[str, str]] = []
        gate = threading.Event()

        def fake_scribe(path, spend=None):
            # By the time the first call is running, both steps must already
            # have been announced as active.
            gate.set()
            return self._transcript()

        def fake_isolate(path, dst, spend=None):
            gate.wait(5)

        with mock.patch.object(ingest, "scribe", side_effect=fake_scribe), \
             mock.patch.object(ingest, "voice_isolate", side_effect=fake_isolate), \
             mock.patch.object(ingest, "clean_audio",
                               side_effect=lambda src, dst, sr=24000: write_wav(Path(dst), 3.0)), \
             mock.patch.object(ingest, "to_wav",
                               side_effect=lambda src, dst, a=None, b=None: write_wav(Path(dst), 1.0)):
            ingest.analyze(self.wd / "in.wav", self.wd,
                           progress=lambda k, s: seen.append((k, s)))

        self.assertEqual(seen[:2], [("transcribe", "active"), ("isolate", "active")])
        self.assertIn(("transcribe", "done"), seen)
        self.assertIn(("isolate", "done"), seen)

    def test_an_isolator_failure_still_reaches_the_caller(self) -> None:
        boom = ingest.ExternalError("elevenlabs", 402, "out of credit")

        def fake_isolate(path, dst, spend=None):
            spend.charge(ingest.ELEVEN)
            raise boom

        ledger = ingest.Spend()
        with mock.patch.object(ingest, "scribe",
                               side_effect=lambda p, spend=None: (
                                   spend.charge(ingest.ELEVEN), self._transcript())[1]), \
             mock.patch.object(ingest, "voice_isolate", side_effect=fake_isolate):
            with self.assertRaises(ingest.ExternalError) as ctx:
                ingest.analyze(self.wd / "in.wav", self.wd, spend=ledger)
        self.assertIs(ctx.exception, boom)
        # BOTH calls are on the ledger: the one that succeeded is not erased by
        # the one that failed, which is what running them in parallel must not
        # cost. `_persist` mirrors this snapshot, so the failure path records it.
        self.assertEqual(ledger.snapshot()["calls"][ingest.ELEVEN], 2)

    def test_when_both_fail_the_caller_sees_the_transcription_error(self) -> None:
        """The error a user gets must not change because of an internal
        scheduling decision. Serially, scribe failed first and the isolator
        never ran, so scribe's error is the one this phase has always raised."""
        scribe_boom = ingest.ExternalError("elevenlabs", 500, "scribe down")
        iso_boom = ingest.ExternalError("elevenlabs", 500, "isolator down")

        def fail_scribe(path, spend=None):
            spend.charge(ingest.ELEVEN)
            time.sleep(0.05)          # lose the race on purpose
            raise scribe_boom

        def fail_isolate(path, dst, spend=None):
            spend.charge(ingest.ELEVEN)
            raise iso_boom

        ledger = ingest.Spend()
        with mock.patch.object(ingest, "scribe", side_effect=fail_scribe), \
             mock.patch.object(ingest, "voice_isolate", side_effect=fail_isolate):
            with self.assertRaises(ingest.ExternalError) as ctx:
                ingest.analyze(self.wd / "in.wav", self.wd, spend=ledger)
        self.assertIs(ctx.exception, scribe_boom)
        self.assertEqual(ledger.snapshot()["calls"][ingest.ELEVEN], 2)

    def test_the_sovereign_path_makes_no_paid_call_at_all(self) -> None:
        """Untouched, and pinned: the local-only analyze has no second thread
        and no provider to overlap."""
        def fake_clean_local(src, dst):
            write_wav(Path(dst), 3.0)

        before = threading.active_count()
        with mock.patch.object(ingest, "scribe") as scr, \
             mock.patch.object(ingest, "voice_isolate") as iso, \
             mock.patch.object(ingest, "clean_local", side_effect=fake_clean_local), \
             mock.patch.object(ingest, "to_wav",
                               side_effect=lambda src, dst, a=None, b=None: write_wav(Path(dst), 1.0)):
            res = ingest.sovereign_analyze(self.wd / "in.wav", self.wd)
        scr.assert_not_called()
        iso.assert_not_called()
        self.assertEqual(threading.active_count(), before)
        self.assertTrue(res["speakers"])


class SegmentMetricsMemoTests(unittest.TestCase):
    """One decode per segment, whatever the flow asks for."""

    SEGS = [("baseline", 2.0, 0.9), ("happy", 3.0, 0.9), ("happy", 1.2, 0.4),
            ("happy", 2.0, 0.8), ("sad", 1.5, 0.7), ("sad", 2.5, 0.6)]

    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)
        self.wd = self.root / "j1"
        ingest_api._METRICS.clear()
        self.addCleanup(ingest_api._METRICS.clear)
        self.scan = _Scan(self.wd, self.SEGS)
        # `_Scan` splices the stems, which reads the segment wavs through
        # ingest's own code — the memo covers the ingest_api readers, so the
        # counters start from a clean slate here.
        ingest_api._METRICS.clear()

    def _counted(self):
        counts = {"seconds": 0, "levels": 0, "rows": 0}
        real_seconds = ingest_api._wav_seconds
        real_levels = ingest.measure_levels
        real_rows = ingest_api.segment_rows

        def seconds(path):
            counts["seconds"] += 1
            return real_seconds(path)

        def levels(path):
            counts["levels"] += 1
            return real_levels(path)

        def rows(work_dir, result):
            counts["rows"] += 1
            return real_rows(work_dir, result)

        return counts, [mock.patch.object(ingest_api, "_wav_seconds", seconds),
                        mock.patch.object(ingest, "measure_levels", levels),
                        mock.patch.object(ingest_api, "segment_rows", rows)]

    def test_three_traversals_decode_the_audio_once(self) -> None:
        """THE pass-count proof.

        The flow's real shape after a scan: build the recipes, build the casting
        board, then a debounced /stems rebuilds the board again. That is THREE
        `segment_rows` traversals. Before the memo each one re-opened every
        segment wav and the recipe pass additionally ran a full frame-RMS decode
        per candidate; now every file is measured exactly once.
        """
        counts, patches = self._counted()
        n = len(self.SEGS)
        with mock.patch.object(ingest_api, "_variants",
                               wraps=ingest_api._variants) as variants:
            for p in patches:
                p.start()
            try:
                res = self.scan.result()
                ingest_api.build_recipes(self.wd, res)
                ingest_api._board(self.wd, res)
                ingest_api._board(self.wd, res)
            finally:
                for p in reversed(patches):
                    p.stop()

        self.assertEqual(counts["rows"], 3)      # three traversals happened...
        self.assertEqual(counts["seconds"], n)   # ...over ONE header read each
        # ...and the full decode ran once per segment at most, never per pass.
        self.assertLessEqual(counts["levels"], n)
        self.assertGreater(counts["levels"], 0,  # the `tightest` recipe really ran
                           "no levels were measured; the memo proves nothing")
        self.assertTrue(variants.called)
        measured_once = dict(counts)

        # THE "BEFORE", executed rather than quoted: emptying the memo ahead of
        # each traversal is precisely what the un-memoized code did, and it pays
        # for every file every time.
        counts, patches = self._counted()
        for p in patches:
            p.start()
        try:
            fresh = self.scan.result()
            for call in (lambda: ingest_api.build_recipes(self.wd, fresh),
                         lambda: ingest_api._board(self.wd, fresh),
                         lambda: ingest_api._board(self.wd, fresh)):
                ingest_api._METRICS.clear()
                call()
        finally:
            for p in reversed(patches):
                p.stop()
        self.assertEqual(counts["rows"], 3)
        self.assertEqual(counts["seconds"], 3 * n)          # was 3n, is n
        self.assertEqual(counts["levels"], measured_once["levels"])

    def test_a_reset_rebuild_costs_no_new_decodes(self) -> None:
        """`/stems` with `reset` re-runs `build_recipes` end to end. That used
        to re-decode everything; it is now free."""
        res = self.scan.result()
        ingest_api.build_recipes(self.wd, res)
        counts, patches = self._counted()
        for p in patches:
            p.start()
        try:
            fresh = self.scan.result()
            ingest_api.build_recipes(self.wd, fresh)
        finally:
            for p in reversed(patches):
                p.stop()
        self.assertEqual(counts["seconds"], 0)
        self.assertEqual(counts["levels"], 0)

    def test_memoized_answers_are_byte_identical(self) -> None:
        """Cold memo vs hot memo: the same plan, the same offers, the same
        proposed board. An optimization that changed an answer would be a bug
        wearing a performance costume."""
        cold_res = self.scan.result()
        cold_plan, cold_why = ingest_api.build_recipes(self.wd, cold_res)
        cold_rows, cold_proposed, _ = ingest_api._board(self.wd, cold_res)

        hot_res = self.scan.result()
        hot_plan, hot_why = ingest_api.build_recipes(self.wd, hot_res)
        hot_rows, hot_proposed, _ = ingest_api._board(self.wd, hot_res)

        self.assertEqual(cold_plan, hot_plan)
        self.assertEqual(cold_why, hot_why)
        self.assertEqual(cold_proposed, hot_proposed)
        self.assertEqual(cold_rows, hot_rows)
        self.assertEqual([s.get("recipes") for s in cold_res["stems"]],
                         [s.get("recipes") for s in hot_res["stems"]])

    def test_the_memo_re_measures_a_file_whose_bytes_changed(self) -> None:
        """Keyed on (size, mtime_ns) rather than on an invalidation protocol.
        `/stems` rewrites `stem_*.wav` and never `seg_*.wav`, so nothing in the
        flow invalidates anything today — but a memo that could serve a stale
        answer would be one refactor away from splicing the wrong audio."""
        wav = self.wd / "seg_000.wav"
        self.assertEqual(ingest_api.segment_seconds(self.wd, wav), 2.0)
        time.sleep(0.01)
        write_wav(wav, 5.0)
        self.assertEqual(ingest_api.segment_seconds(self.wd, wav), 5.0)

    def test_a_missing_file_is_not_cached(self) -> None:
        gone = self.wd / "seg_999.wav"
        self.assertEqual(ingest_api.segment_seconds(self.wd, gone), 0.0)
        self.assertNotIn(str(gone), ingest_api._METRICS.get(str(self.wd), {}))

    def test_the_memo_is_dropped_with_the_job(self) -> None:
        ingest_api.build_recipes(self.wd, self.scan.result())
        self.assertIn(str(self.wd), ingest_api._METRICS)
        ingest_api.forget_metrics(self.wd)
        self.assertNotIn(str(self.wd), ingest_api._METRICS)

    def test_the_memo_lock_is_a_leaf(self) -> None:
        """`_METRICS_LOCK` must never be held across another acquisition, or it
        would join the `_STEM_LOCK` -> `_LOCK` order that `restem` and `commit`
        depend on. Proven by holding it and doing the whole flow's work from
        another thread: if a measurement ran inside it, this would deadlock."""
        done = threading.Event()
        out: list[object] = []

        def worker() -> None:
            out.append(ingest_api.build_recipes(self.wd, self.scan.result()))
            done.set()

        with ingest_api._METRICS_LOCK:
            t = threading.Thread(target=worker, daemon=True)
            t.start()
            # The memo lookups block; the MEASUREMENTS must not, and the lock
            # must be released between them — so releasing it here lets the
            # whole pass through immediately.
            time.sleep(0.05)
            self.assertFalse(done.is_set())
        self.assertTrue(done.wait(10), "the metrics lock is not a leaf")
        t.join(5)
        self.assertTrue(out and out[0][1] is None)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
