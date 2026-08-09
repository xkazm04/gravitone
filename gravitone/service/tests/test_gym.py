"""The Conversation Gym - a recorded call replayed, and two runs scored.

Every case here is driven end to end against the in-process app with the
deterministic scripted brain, a fake worker pool and a stubbed transcriber, so
what is exercised is the REPLAY (framing, turn discovery, artifact shape,
thresholds) and never the model stack. The golden recording is generated in the
test from tone frames - exactly what test_convai_protocol.py streams by hand -
because a fixture WAV checked into the repo would make these cases depend on a
recording nobody can regenerate.
"""
from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path

from service.tests import fake_engine  # installs shims - must precede app import

import service.app as appmod  # noqa: E402
from service import convai, dialog, gym, recording, stt  # noqa: E402
from service.tests.test_convai_protocol import heard  # noqa: E402
from service.tests.test_vad import silence, tone  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

AGENT = "local-interviewer"
RATE = 16000
FIXTURES = Path(__file__).parent / "fixtures" / "gym"
HEARD = ["I've been building backend services for six years.",
         "Mostly Python and PostgreSQL, with some Kubernetes."]


def write_wav(path: Path, pcm: bytes, rate: int = RATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def make_golden(directory: Path, texts=HEARD, *, transcript: bool = True,
                meta: bool = True) -> Path:
    """A recording directory shaped exactly like one a real call left behind."""
    pcm = b"".join(silence(300) + tone(700) + silence(1200) for _ in texts)
    write_wav(directory / "user.wav", pcm)
    if transcript:
        turns = [{"role": "candidate", "text": t, "at_s": 0.3 + 2.2 * i,
                  "audio_s": 0.7, "transcribe_s": 0.01}
                 for i, t in enumerate(texts)]
        (directory / "transcript.json").write_text(
            json.dumps({"conversation_id": directory.name, "sample_rate": RATE,
                        "turns": turns}), "utf-8")
    if meta:
        (directory / "meta.json").write_text(
            json.dumps({"agent_id": AGENT, "brain": {"backend": "scripted"}}),
            "utf-8")
    return directory


class _GymCase(unittest.TestCase):
    """A ready app: fake pool, scripted brain, stubbed ear, temp directories."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.recordings = self.tmp / "recordings"
        self.recordings.mkdir(parents=True, exist_ok=True)
        self.runs = self.tmp / "runs"

        self._orig_recording = recording.SETTINGS
        self._orig_gym = gym.SETTINGS
        recording.SETTINGS = dataclasses.replace(
            recording.SETTINGS, convai_recordings_dir=str(self.recordings))
        gym.SETTINGS = dataclasses.replace(
            gym.SETTINGS, convai_recordings_dir=str(self.recordings))

        self._orig_engine = appmod.ENGINE
        self._orig_transcribe = stt.transcribe_pcm
        self._orig_backend = convai._BACKEND
        convai._BACKEND = dialog.ScriptedBackend()
        self._calls = 0

        def _fake_transcribe(pcm, **kwargs):
            # Cycles, so the Nth utterance of every replay hears the same words
            # however many replays the test has already run. A clamped index
            # would make run 2 of a suite hear something run 1 did not.
            text = HEARD[self._calls % len(HEARD)]
            self._calls += 1
            return heard(text)

        stt.transcribe_pcm = _fake_transcribe
        self.engine = fake_engine.FakeEngine(workers=2, delay=0.01)
        appmod.ENGINE = self.engine

    def tearDown(self) -> None:
        recording.SETTINGS = self._orig_recording
        gym.SETTINGS = self._orig_gym
        appmod.ENGINE = self._orig_engine
        stt.transcribe_pcm = self._orig_transcribe
        convai._BACKEND = self._orig_backend
        convai._Sessions.active = 0
        self.engine.close()
        self._tmp.cleanup()

    def golden(self, name: str = "two-turns", **kwargs) -> Path:
        return make_golden(self.recordings / name, **kwargs)

    def replay(self, source, **kwargs) -> dict:
        kwargs.setdefault("app", appmod.app)
        kwargs.setdefault("work_dir", self.runs)
        kwargs.setdefault("quiet_ms", 500)
        kwargs.setdefault("deadline_s", 60.0)
        kwargs.setdefault("override", {"first_message": ""})
        return gym.replay(source, **kwargs)


class ReplayTests(_GymCase):
    def test_a_recording_replays_into_the_same_conversation(self) -> None:
        run = self.replay(self.golden())

        self.assertEqual(run["schema"], gym.RUN_SCHEMA)
        self.assertEqual(run["agent_id"], AGENT)
        self.assertEqual(run["brain"]["backend"], "scripted")
        # The recorder is the only half that knows what a turn cost, so a replay
        # that recorded reports from it.
        self.assertEqual(run["timings_source"], "recorder")
        roles = [t["role"] for t in run["turns"]]
        self.assertEqual(roles, ["candidate", "agent", "candidate", "agent"])
        self.assertEqual([t["text"] for t in run["turns"] if t["role"] == "candidate"],
                         HEARD)
        self.assertEqual(run["turns"][1]["text"],
                         dialog.BUILTIN_AGENTS[AGENT].script[0])
        # Turn indices are the artifact's own, in order.
        self.assertEqual([t["i"] for t in run["turns"]], [0, 1, 2, 3])

    def test_the_artifact_carries_the_wire_and_the_totals(self) -> None:
        run = self.replay(self.golden())

        wire = run["wire"]
        self.assertEqual(wire["rate"], RATE)
        self.assertEqual(wire["pace"], 0.0)
        self.assertFalse(wire["realtime"])
        self.assertGreater(wire["frames"], 20)
        self.assertGreater(wire["audio_s"], 4.0)

        totals = run["totals"]
        self.assertEqual(totals["turns"], 4)
        self.assertEqual(totals["candidate_turns"], 2)
        self.assertEqual(totals["agent_turns"], 2)
        self.assertEqual(totals["interruptions"], 0)
        self.assertEqual(totals["transcribe_s"]["n"], 2)
        self.assertGreater(totals["wall_s"], 0.0)
        self.assertGreater(run["events"]["audio"], 0)
        self.assertEqual(run["events"]["user_transcript"], 2)

    def test_drift_is_labelled_as_drift_not_accuracy(self) -> None:
        run = self.replay(self.golden())
        drift = run["drift_vs_source"]
        self.assertTrue(drift["available"])
        self.assertEqual(drift["wer"], 0.0)   # the same ear heard the same words
        self.assertIn("not accuracy against ground truth", drift["note"])

    def test_a_recording_with_no_transcript_still_replays(self) -> None:
        """A bare user.wav is a valid fixture - it just cannot be scored."""
        run = self.replay(self.golden("bare", transcript=False))
        self.assertEqual(run["totals"]["candidate_turns"], 2)
        self.assertFalse(run["drift_vs_source"]["available"])
        self.assertIn("no transcript", run["drift_vs_source"]["why"])

    def test_a_bare_wav_path_is_a_source_too(self) -> None:
        directory = self.golden("wavonly")
        run = self.replay(directory / "user.wav", agent_id=AGENT)
        self.assertEqual(run["source_name"], "user")
        self.assertEqual(run["totals"]["candidate_turns"], 2)

    def test_a_recording_id_resolves_against_the_recordings_dir(self) -> None:
        self.golden("byid")
        run = self.replay("byid")
        self.assertEqual(run["source_name"], "byid")

    def test_the_replay_keeps_its_own_run_recording(self) -> None:
        run = self.replay(self.golden())
        left = self.runs / run["conversation_id"]
        self.assertTrue((left / "user.wav").is_file())
        self.assertTrue((left / "transcript.json").is_file())
        # The service's own recordings directory is NOT written into: a replay
        # is evidence for a test run, not a new conversation.
        self.assertEqual(sorted(p.name for p in self.recordings.iterdir()),
                         ["two-turns"])

    def test_recording_stays_off_afterwards(self) -> None:
        """The privacy default is restored even though the replay forced it on."""
        self.assertFalse(recording.SETTINGS.convai_record)
        self.replay(self.golden())
        self.assertFalse(recording.SETTINGS.convai_record)
        self.assertEqual(recording.SETTINGS.convai_recordings_dir,
                         str(self.recordings))

    def test_an_unknown_source_says_where_it_looked(self) -> None:
        with self.assertRaises(gym.GymError) as caught:
            self.replay("nope")
        self.assertIn("CONVAI_RECORD", str(caught.exception))

    def test_a_directory_without_audio_is_refused(self) -> None:
        empty = self.recordings / "empty"
        empty.mkdir()
        with self.assertRaises(gym.GymError) as caught:
            self.replay(empty)
        self.assertIn("user.wav", str(caught.exception))

    def test_an_unknown_agent_names_the_ones_that_exist(self) -> None:
        with self.assertRaises(gym.GymError) as caught:
            self.replay(self.golden(), agent_id="not-an-agent")
        self.assertIn(AGENT, str(caught.exception))

    def test_a_recording_that_names_no_agent_asks_for_one(self) -> None:
        with self.assertRaises(gym.GymError) as caught:
            self.replay(self.golden("nometa", meta=False))
        self.assertIn("agent_id", str(caught.exception))

    def test_a_polite_replay_does_not_invent_a_barge_in(self) -> None:
        """The default: an unpaced feed still waits out the agent's reply.

        Blasting the whole recording in makes the caller's SECOND utterance
        arrive while the agent is answering the first, which would report
        interruptions the original call never had.
        """
        run = self.replay(self.golden())
        self.assertEqual(run["totals"]["interruptions"], 0)
        self.assertTrue(run["wire"]["polite"])
        self.assertEqual(run["events"]["interruption"], 0)

    def test_a_slow_synthesizer_does_not_break_politeness(self) -> None:
        """The floor is held while a reply is announced but not yet audible.

        A real model takes ~1.5s to produce a reply's first sentence; in that
        gap the wire is silent. The driver used to read that silence as "the
        agent finished" and blast the whole recording over the opening —
        turning every polite replay against a real engine into a pile of
        invented barge-ins. An engine slower than the polite quiet window is
        the regression guard.
        """
        self.engine.close()
        self.engine = fake_engine.FakeEngine(workers=2, delay=0.7)
        appmod.ENGINE = self.engine
        run = self.replay(self.golden(), pace=0.0,
                          override=None)  # keep the (slow) opening line
        self.assertEqual(run["totals"]["interruptions"], 0)
        self.assertEqual(run["totals"]["candidate_turns"], 2)

    def test_a_slow_transcriber_does_not_break_politeness(self) -> None:
        """The feed also yields after the CALLER finishes an utterance.

        The answer to an utterance begins with silence — a real transcriber
        needs seconds — and at pace 0 the next utterance used to land inside
        that silence, cancelling the half-formed answer as a barge-in. The
        stubbed ear gets a real delay to reproduce what the instant stub
        always hid.
        """
        instant = stt.transcribe_pcm

        def slow_transcribe(pcm, **kwargs):
            time.sleep(0.5)
            return instant(pcm, **kwargs)

        stt.transcribe_pcm = slow_transcribe
        run = self.replay(self.golden(), pace=0.0)
        self.assertEqual(run["totals"]["interruptions"], 0)
        self.assertEqual(run["totals"]["candidate_turns"], 2)
        self.assertEqual(run["totals"]["agent_turns"], 2)

    def test_an_impolite_replay_talks_over_the_agent(self) -> None:
        """The other half of the same claim - barge-in on purpose.

        A slow pool (as test_convai_protocol's interruption case uses) keeps the
        reply rendering while the second utterance arrives, so this is a fact
        about the feed and not a race.
        """
        self.engine.close()
        self.engine = fake_engine.FakeEngine(workers=2, delay=1.0)
        appmod.ENGINE = self.engine
        run = self.replay(self.golden(), polite=False)
        self.assertFalse(run["wire"]["polite"])
        self.assertGreaterEqual(run["events"]["interruption"], 1)
        self.assertGreaterEqual(run["totals"]["interruptions"], 1)

    def test_the_opening_is_spoken_when_it_is_not_overridden(self) -> None:
        """The disclosure turn: replaying with the agent as configured."""
        run = self.replay(self.golden(), override=None)
        first = next(t for t in run["turns"] if t["role"] == "agent")
        self.assertEqual(first["text"], dialog.BUILTIN_AGENTS[AGENT].first_message)
        self.assertIn("transcribed", first["text"])


class WordErrorRateTests(unittest.TestCase):
    def test_identical_transcripts_do_not_drift(self) -> None:
        self.assertEqual(gym.word_error_rate(["one two three"],
                                            ["one two three"])["wer"], 0.0)

    def test_one_wrong_word_in_four_is_a_quarter(self) -> None:
        scored = gym.word_error_rate(["a b c d"], ["a b x d"])
        self.assertEqual(scored["wer"], 0.25)
        self.assertEqual(scored["errors"], 1)
        self.assertEqual(scored["reference_words"], 4)

    def test_insertions_and_deletions_both_count(self) -> None:
        self.assertEqual(gym.word_error_rate(["a b"], ["a b c"])["errors"], 1)
        self.assertEqual(gym.word_error_rate(["a b c"], ["a c"])["errors"], 1)

    def test_a_missing_turn_is_a_whole_turn_of_errors(self) -> None:
        scored = gym.word_error_rate(["a b", "c d e"], ["a b"])
        self.assertEqual(scored["errors"], 3)
        self.assertEqual(scored["turns"], 2)

    def test_punctuation_and_case_are_not_drift(self) -> None:
        self.assertEqual(gym.word_error_rate(["Hello, world."],
                                            ["hello world"])["wer"], 0.0)

    def test_nothing_against_something_is_total(self) -> None:
        self.assertEqual(gym.word_error_rate([], ["a b"])["wer"], 1.0)
        self.assertEqual(gym.word_error_rate([], [])["wer"], 0.0)


class DistributionTests(unittest.TestCase):
    def test_absent_is_absent_not_zero(self) -> None:
        self.assertEqual(gym.dist([None, 1.0, None, 3.0]),
                         {"n": 2, "mean": 2.0, "p50": 2.0, "max": 3.0})

    def test_no_measurements_reports_none_rather_than_a_number(self) -> None:
        self.assertEqual(gym.dist([None]),
                         {"n": 0, "mean": None, "p50": None, "max": None})

    def test_the_median_is_the_middle_of_the_sorted_values(self) -> None:
        self.assertEqual(gym.dist([9.0, 1.0, 2.0])["p50"], 2.0)


def make_run(**over) -> dict:
    """A minimal run artifact, so compare() can be tested without a socket."""
    turns = over.pop("turns", [
        {"i": 0, "role": "candidate", "text": "hello there", "audio_s": 1.0,
         "transcribe_s": 0.10, "answer_s": None, "interrupted": False},
        {"i": 1, "role": "agent", "text": "Good morning.", "audio_s": None,
         "transcribe_s": None, "answer_s": 0.40, "interrupted": False},
    ])
    run = {
        "schema": gym.RUN_SCHEMA, "run_id": "r" + str(over.pop("n", 1)),
        "agent_id": AGENT, "source_name": "golden", "timings_source": "recorder",
        "brain": {"backend": "scripted"},
        "wire": {"rate": RATE, "frame_ms": 100, "pace": over.pop("pace", 0.0),
                 "realtime": False, "audio_s": 2.0, "frames": 20},
        "turns": turns,
        "totals": gym._totals(turns, 3.0, {"audio": 4}),
        "drift_vs_source": {"available": False},
        "events": {},
    }
    run.update(over)
    return run


class CompareTests(unittest.TestCase):
    def test_a_run_compared_with_itself_passes(self) -> None:
        result = gym.compare(make_run(), make_run())
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(gym.exit_code(result), 0)
        self.assertTrue(all(c["pass"] for c in result["checks"]))
        self.assertEqual(result["schema"], gym.COMPARE_SCHEMA)

    def test_a_changed_caller_transcript_fails_as_drift(self) -> None:
        b = make_run(turns=[
            {"i": 0, "role": "candidate", "text": "hello dare", "audio_s": 1.0,
             "transcribe_s": 0.10, "answer_s": None, "interrupted": False},
            {"i": 1, "role": "agent", "text": "Good morning.", "audio_s": None,
             "transcribe_s": None, "answer_s": 0.40, "interrupted": False},
        ])
        result = gym.compare(make_run(), b)
        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(gym.exit_code(result), 2)
        self.assertEqual(self._failed(result), ["caller_transcript_drift"])
        self.assertIn("DRIFT", result["wer_drift"]["note"])

    def test_a_changed_agent_turn_is_reported_with_both_texts(self) -> None:
        b = make_run(turns=[
            {"i": 0, "role": "candidate", "text": "hello there", "audio_s": 1.0,
             "transcribe_s": 0.10, "answer_s": None, "interrupted": False},
            {"i": 1, "role": "agent", "text": "Good evening.", "audio_s": None,
             "transcribe_s": None, "answer_s": 0.40, "interrupted": False},
        ])
        result = gym.compare(make_run(), b)
        self.assertEqual(self._failed(result), ["agent_text_stable"])
        changed = result["agent_text"]["changed"]
        self.assertEqual(changed[0]["a"], "Good morning.")
        self.assertEqual(changed[0]["b"], "Good evening.")

    def test_a_lost_turn_fails_the_structure_check(self) -> None:
        result = gym.compare(make_run(), make_run(turns=[]))
        self.assertIn("turn_count_stable", self._failed(result))
        self.assertEqual(result["turn_count"]["delta"], -2)

    def test_a_new_interruption_fails(self) -> None:
        b = make_run()
        b["turns"][1]["interrupted"] = True
        b["totals"] = gym._totals(b["turns"], 3.0, {"audio": 4})
        result = gym.compare(make_run(), b)
        self.assertEqual(self._failed(result), ["interruptions_stable"])
        self.assertEqual(result["interruptions"], {"a": 0, "b": 1, "delta": 1})

    def test_a_slower_answer_fails_and_a_faster_one_does_not(self) -> None:
        slower = make_run()
        slower["turns"][1]["answer_s"] = 2.0
        slower["totals"] = gym._totals(slower["turns"], 3.0, {"audio": 4})
        result = gym.compare(make_run(), slower)
        self.assertEqual(self._failed(result), ["answer_s_no_regression"])
        self.assertAlmostEqual(result["latency"]["answer_s"]["delta_mean_s"], 1.6)

        faster = make_run()
        faster["turns"][1]["answer_s"] = 0.05
        faster["totals"] = gym._totals(faster["turns"], 3.0, {"audio": 4})
        self.assertEqual(gym.compare(make_run(), faster)["verdict"], "pass")

    def test_noise_inside_the_absolute_slack_is_not_a_regression(self) -> None:
        b = make_run()
        b["turns"][1]["answer_s"] = 0.45          # +0.05s on a 0.40s baseline
        b["totals"] = gym._totals(b["turns"], 3.0, {"audio": 4})
        self.assertEqual(gym.compare(make_run(), b)["verdict"], "pass")

    def test_thresholds_can_be_loosened_per_call(self) -> None:
        slower = make_run()
        slower["turns"][1]["answer_s"] = 2.0
        slower["totals"] = gym._totals(slower["turns"], 3.0, {"audio": 4})
        result = gym.compare(make_run(), slower,
                             {"answer_s_regression_abs_max_s": 5.0})
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(result["thresholds"]["answer_s_regression_abs_max_s"], 5.0)

    def test_a_wrong_schema_artifact_fails_rather_than_scoring_nothing(self) -> None:
        """The CLI and the suite call compare() directly - the 422 on the HTTP
        surface never sees them. A comparison handed in where a run belongs has
        no turns, so every other check passes vacuously."""
        result = gym.compare(make_run(), {"schema": gym.COMPARE_SCHEMA})
        self.assertEqual(result["verdict"], "fail")
        self.assertIn("comparable_schema", self._failed(result))
        self.assertIn(gym.COMPARE_SCHEMA, result["checks"][0]["got"])

    def test_an_older_run_schema_on_the_baseline_side_fails_too(self) -> None:
        stale = make_run()
        stale["schema"] = "gravitone-gym-run/0"
        self.assertIn("comparable_schema",
                      self._failed(gym.compare(stale, make_run())))

    def test_two_pacings_are_not_compared_on_latency(self) -> None:
        """A run streamed in real time and one blasted in are two experiments."""
        slower = make_run(pace=1.0)
        slower["turns"][1]["answer_s"] = 9.0
        slower["totals"] = gym._totals(slower["turns"], 3.0, {"audio": 4})
        result = gym.compare(make_run(pace=0.0), slower)
        self.assertEqual(self._failed(result), ["comparable_pacing"])
        answer = next(c for c in result["checks"]
                      if c["check"] == "answer_s_no_regression")
        self.assertIn("not scored", answer["got"])

    def test_a_run_with_no_latency_measured_is_not_scored_on_it(self) -> None:
        a = make_run()
        a["turns"][1]["answer_s"] = None
        a["totals"] = gym._totals(a["turns"], 3.0, {"audio": 4})
        result = gym.compare(a, make_run())
        self.assertEqual(result["verdict"], "pass")
        self.assertIn("nothing to compare",
                      result["latency"]["answer_s"]["why"])

    @staticmethod
    def _failed(result: dict) -> list[str]:
        return [c["check"] for c in result["checks"] if not c["pass"]]


class BaselineWriteTests(unittest.TestCase):
    """A baseline is written the way `recording.save_care` writes care marks:
    atomically, and behind a cross-process lock. Two suite runners (two CI
    shards, or a studio replay racing a CI job) are not hypothetical."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_a_written_baseline_carries_its_stamp(self) -> None:
        path = self.tmp / "baselines" / "case.json"
        gym.write_baseline(path, make_run(), gym.THRESHOLDS)
        stored = json.loads(path.read_text("utf-8"))
        self.assertEqual(stored["schema"], gym.RUN_SCHEMA)
        stamp = stored["baseline"]
        self.assertEqual(stamp["schema"], gym.BASELINE_SCHEMA)
        self.assertEqual(stamp["check_set"], gym.CHECK_SET)
        self.assertEqual(stamp["thresholds"], sorted(gym.THRESHOLDS))
        self.assertGreater(stamp["written_at"], 0)
        # A stamped baseline is still a run artifact compare() will score.
        self.assertEqual(gym.compare(stored, make_run())["verdict"], "pass")
        self.assertIsNone(gym.baseline_staleness(stored, gym.THRESHOLDS))

    def test_concurrent_writers_serialize_and_leave_one_whole_file(self) -> None:
        """The lock is the claim, so the test watches for OVERLAP rather than
        only for a readable result: an unlocked writer usually still leaves
        valid JSON (os.replace is atomic), which is exactly why a corruption
        check alone would pass on the bug this guards."""
        path = self.tmp / "baselines" / "case.json"
        inside = 0
        overlaps = []
        real = gym.atomic_write_text
        guard = threading.Lock()

        def watched(target, text, encoding="utf-8"):
            nonlocal inside
            with guard:
                inside += 1
                if inside > 1:
                    overlaps.append(inside)
            time.sleep(0.02)      # widen the window a lock has to close
            real(target, text, encoding)
            with guard:
                inside -= 1

        gym.atomic_write_text = watched
        self.addCleanup(setattr, gym, "atomic_write_text", real)

        errors: list[BaseException] = []

        def write(n: int) -> None:
            try:
                gym.write_baseline(path, make_run(n=n), gym.THRESHOLDS)
            except BaseException as exc:   # noqa: BLE001 - reported, not hidden
                errors.append(exc)

        threads = [threading.Thread(target=write, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)

        self.assertEqual(errors, [])
        self.assertEqual(overlaps, [], "two writers were inside the write at once")
        stored = json.loads(path.read_text("utf-8"))   # whole, not torn
        self.assertIn(stored["run_id"], {f"r{i}" for i in range(6)})
        self.assertEqual(stored["baseline"]["check_set"], gym.CHECK_SET)
        # The lock file is released, not leaked - the next runner must not wait
        # out `LOCK_STALE_S` for a lock nobody holds.
        self.assertFalse((path.parent / f".{path.name}.lock").exists())


class BaselineStalenessTests(unittest.TestCase):
    def test_a_current_baseline_is_not_stale(self) -> None:
        written = dict(make_run(), baseline=gym.baseline_stamp(gym.THRESHOLDS))
        self.assertIsNone(gym.baseline_staleness(written, gym.THRESHOLDS))

    def test_a_baseline_with_no_stamp_is_stale(self) -> None:
        """Everything written before this stamp existed. Unknown provenance is
        treated as wrong provenance, because the alternative is a verdict."""
        why = gym.baseline_staleness(make_run(), gym.THRESHOLDS)
        self.assertIsNotNone(why)
        self.assertIn("no baseline stamp", why)

    def test_an_older_check_set_is_stale(self) -> None:
        written = dict(make_run(), baseline=dict(
            gym.baseline_stamp(gym.THRESHOLDS), check_set="gravitone-gym-checks/0"))
        why = gym.baseline_staleness(written, gym.THRESHOLDS)
        self.assertIn("gravitone-gym-checks/0", why)
        self.assertIn(gym.CHECK_SET, why)

    def test_a_new_threshold_makes_an_old_baseline_stale_by_name(self) -> None:
        """A check added since the baseline was minted was never scored on it."""
        older = {k: v for k, v in gym.THRESHOLDS.items() if k != "wer_drift_max"}
        written = dict(make_run(), baseline=gym.baseline_stamp(older))
        why = gym.baseline_staleness(written, gym.THRESHOLDS)
        self.assertIn("wer_drift_max", why)

    def test_a_retuned_threshold_value_is_not_staleness(self) -> None:
        """Editing a bar in suite.json is a decision about the current run."""
        written = dict(make_run(), baseline=gym.baseline_stamp(gym.THRESHOLDS))
        self.assertIsNone(gym.baseline_staleness(
            written, dict(gym.THRESHOLDS, wer_drift_max=0.5)))

    def test_a_non_run_document_is_stale_before_anything_else(self) -> None:
        why = gym.baseline_staleness({"schema": gym.SUITE_SCHEMA}, gym.THRESHOLDS)
        self.assertIn(gym.RUN_SCHEMA, why)


class RetentionTests(unittest.TestCase):
    """`gym-runs` is CI scratch and gets a retention pass of its own, in the
    shape `recording.evict_oldest` established."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.runs = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def make_runs(self, count: int) -> list[Path]:
        made = []
        for i in range(count):
            d = self.runs / f"conv{i:03d}"
            d.mkdir()
            (d / "transcript.json").write_text("{}", "utf-8")
            (d / "user.wav").write_bytes(b"RIFF")
            os.utime(d, (1_700_000_000 + i, 1_700_000_000 + i))
            made.append(d)
        return made

    def test_the_oldest_runs_go_and_the_newest_stay(self) -> None:
        made = self.make_runs(8)
        self.assertEqual(gym.evict_runs(self.runs, limit=3), 5)
        self.assertEqual(sorted(d.name for d in self.runs.iterdir()),
                         [d.name for d in made[-3:]])

    def test_under_the_limit_nothing_is_touched(self) -> None:
        self.make_runs(3)
        self.assertEqual(gym.evict_runs(self.runs, limit=gym.MAX_RUNS), 0)
        self.assertEqual(len(list(self.runs.iterdir())), 3)

    def test_a_directory_that_does_not_exist_is_not_an_error(self) -> None:
        self.assertEqual(gym.evict_runs(self.runs / "never", limit=1), 0)


class ReplayRetentionTests(_GymCase):
    def test_a_replay_evicts_the_runs_before_it(self) -> None:
        """Symmetric with `recording.close()`: the run that just finished is the
        newest, so it is never the one evicted."""
        self.runs.mkdir(parents=True, exist_ok=True)
        stale = self.runs / "ancient"
        stale.mkdir()
        (stale / "transcript.json").write_text("{}", "utf-8")
        original = gym.MAX_RUNS
        gym.MAX_RUNS = 1
        self.addCleanup(setattr, gym, "MAX_RUNS", original)

        run = self.replay(self.golden())
        self.assertFalse(stale.exists())
        self.assertTrue((self.runs / run["conversation_id"]).is_dir())


class RealComparisonTests(_GymCase):
    def test_two_replays_of_one_recording_agree(self) -> None:
        golden = self.golden()
        first, second = self.replay(golden), self.replay(golden)
        result = gym.compare(first, second)
        self.assertEqual(result["verdict"], "pass", result["checks"])
        self.assertEqual(result["wer_drift"]["wer"], 0.0)
        self.assertEqual(result["runs"]["a"]["brain"], "scripted")


class SuiteTests(_GymCase):
    """A checked-in suite.json plus a generated golden - the shipped shape."""

    def suite_dir(self) -> Path:
        root = self.tmp / "suite"
        shutil.copytree(FIXTURES / "basic", root)
        make_golden(root / "recordings" / "two-turns")
        return root

    def test_the_shipped_fixture_suite_loads(self) -> None:
        suite = gym.load_suite(self.suite_dir())
        self.assertEqual(suite["name"], "basic")
        self.assertEqual([c["name"] for c in suite["cases"]],
                         ["two-turns", "disclosure"])

    def test_a_suite_with_no_baselines_yet_still_passes(self) -> None:
        result = gym.run_suite(self.suite_dir(), app=appmod.app,
                               work_dir=self.runs)
        self.assertEqual(result["verdict"], "pass", result["cases"])
        self.assertEqual(result["totals"]["cases"], 2)
        for case in result["cases"]:
            self.assertIn("none yet", case["baseline"])
            self.assertTrue(case["checks"])

    def test_baselines_make_the_second_run_a_comparison(self) -> None:
        root = self.suite_dir()
        first = gym.run_suite(root, app=appmod.app, work_dir=self.runs,
                              update_baselines=True)
        self.assertEqual(first["verdict"], "pass", first["cases"])
        self.assertTrue((root / "baselines" / "two-turns.json").is_file())

        second = gym.run_suite(root, app=appmod.app, work_dir=self.runs)
        self.assertEqual(second["verdict"], "pass", second["cases"])
        for case in second["cases"]:
            self.assertIn("comparison", case)
            self.assertEqual(case["comparison"]["verdict"], "pass",
                             case["comparison"]["checks"])

    def test_a_regressed_baseline_fails_the_suite(self) -> None:
        root = self.suite_dir()
        gym.run_suite(root, app=appmod.app, work_dir=self.runs,
                      update_baselines=True)
        path = root / "baselines" / "two-turns.json"
        baseline = json.loads(path.read_text("utf-8"))
        for turn in baseline["turns"]:
            if turn["role"] == "candidate":
                turn["text"] = "something else entirely was said here"
        path.write_text(json.dumps(baseline), "utf-8")

        result = gym.run_suite(root, app=appmod.app, work_dir=self.runs)
        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["failed_cases"], ["two-turns"])

    def test_an_expectation_that_does_not_hold_fails_its_case(self) -> None:
        root = self.suite_dir()
        suite = json.loads((root / "suite.json").read_text("utf-8"))
        suite["cases"] = [dict(suite["cases"][0],
                               expect={"first_agent_turn_contains":
                                       ["a thing it never says"]})]
        (root / "suite.json").write_text(json.dumps(suite), "utf-8")
        result = gym.run_suite(root, app=appmod.app, work_dir=self.runs)
        self.assertEqual(result["verdict"], "fail")
        self.assertFalse(result["cases"][0]["checks"][0]["pass"])

    def test_a_missing_recording_errors_that_case_and_not_the_suite(self) -> None:
        root = self.suite_dir()
        suite = json.loads((root / "suite.json").read_text("utf-8"))
        suite["cases"][0]["recording"] = "recordings/gone"
        (root / "suite.json").write_text(json.dumps(suite), "utf-8")
        result = gym.run_suite(root, app=appmod.app, work_dir=self.runs)
        self.assertEqual([c["verdict"] for c in result["cases"]],
                         ["error", "pass"])
        self.assertEqual(result["verdict"], "fail")

    def one_case_dir(self) -> Path:
        """The same fixture trimmed to one case - a suite test that only needs
        the baseline machinery should not pay for two replays."""
        root = self.suite_dir()
        suite = json.loads((root / "suite.json").read_text("utf-8"))
        suite["cases"] = suite["cases"][:1]
        (root / "suite.json").write_text(json.dumps(suite), "utf-8")
        return root

    def test_the_written_baseline_is_stamped_with_its_check_set(self) -> None:
        root = self.one_case_dir()
        gym.run_suite(root, app=appmod.app, work_dir=self.runs,
                      update_baselines=True)
        stamp = json.loads((root / "baselines" / "two-turns.json")
                           .read_text("utf-8"))["baseline"]
        self.assertEqual(stamp["check_set"], gym.CHECK_SET)
        self.assertEqual(stamp["run_schema"], gym.RUN_SCHEMA)

    def test_a_stale_baseline_is_refused_rather_than_scored(self) -> None:
        """A baseline minted under an older check set answers a different
        question. Comparing it anyway produces a verdict that looks like
        evidence, which is worse than no verdict at all."""
        root = self.one_case_dir()
        gym.run_suite(root, app=appmod.app, work_dir=self.runs,
                      update_baselines=True)
        path = root / "baselines" / "two-turns.json"
        baseline = json.loads(path.read_text("utf-8"))
        baseline["baseline"]["check_set"] = "gravitone-gym-checks/0"
        path.write_text(json.dumps(baseline), "utf-8")

        result = gym.run_suite(root, app=appmod.app, work_dir=self.runs)
        self.assertEqual(result["verdict"], "fail")
        case = result["cases"][0]
        self.assertNotIn("comparison", case)   # never silently scored
        failed = [c for c in case["checks"] if not c["pass"]]
        self.assertEqual([c["check"] for c in failed], ["baseline_current"])
        self.assertIn("gravitone-gym-checks/0", case["baseline"])
        self.assertIn("--update-baselines", failed[0]["got"])

    def test_a_baseline_from_before_the_stamp_existed_is_stale(self) -> None:
        """The migration case: every baseline on disk today has no stamp."""
        root = self.one_case_dir()
        gym.run_suite(root, app=appmod.app, work_dir=self.runs,
                      update_baselines=True)
        path = root / "baselines" / "two-turns.json"
        baseline = json.loads(path.read_text("utf-8"))
        baseline.pop("baseline")
        path.write_text(json.dumps(baseline), "utf-8")

        result = gym.run_suite(root, app=appmod.app, work_dir=self.runs)
        self.assertEqual(result["verdict"], "fail")
        self.assertIn("no baseline stamp", result["cases"][0]["baseline"])

    def test_update_baselines_replaces_a_stale_one_and_says_so(self) -> None:
        root = self.one_case_dir()
        gym.run_suite(root, app=appmod.app, work_dir=self.runs,
                      update_baselines=True)
        path = root / "baselines" / "two-turns.json"
        baseline = json.loads(path.read_text("utf-8"))
        baseline["baseline"]["check_set"] = "gravitone-gym-checks/0"
        path.write_text(json.dumps(baseline), "utf-8")

        result = gym.run_suite(root, app=appmod.app, work_dir=self.runs,
                               update_baselines=True)
        self.assertEqual(result["verdict"], "pass", result["cases"])
        case = result["cases"][0]
        self.assertIn("re-baselined", case["baseline"])
        self.assertNotIn("comparison", case)
        self.assertEqual(json.loads(path.read_text("utf-8"))["baseline"]
                         ["check_set"], gym.CHECK_SET)

    def test_a_suite_with_no_cases_is_refused(self) -> None:
        root = self.tmp / "hollow"
        root.mkdir()
        (root / "suite.json").write_text(json.dumps({"cases": []}), "utf-8")
        with self.assertRaises(gym.GymError):
            gym.load_suite(root)

    def test_a_missing_suite_json_says_what_a_suite_is(self) -> None:
        with self.assertRaises(gym.GymError) as caught:
            gym.load_suite(self.tmp / "nothing-here")
        self.assertIn("suite.json", str(caught.exception))


class ReplayEndpointTests(_GymCase):
    """POST /v1/convai/replay on the gym's OWN router (app.py is not edited)."""

    def setUp(self) -> None:
        super().setUp()
        host = FastAPI()
        host.include_router(gym.router)
        self.client = TestClient(host, raise_server_exceptions=False)

    def test_a_recording_id_replays_over_http(self) -> None:
        self.golden("overhttp")
        res = self.client.post("/v1/convai/replay",
                              json={"recording": "overhttp"})
        self.assertEqual(res.status_code, 200, res.text)
        run = res.json()["run"]
        self.assertEqual(run["agent_id"], AGENT)
        self.assertEqual(run["totals"]["candidate_turns"], 2)

    def test_compare_to_scores_the_run_in_one_call(self) -> None:
        golden = self.golden()
        baseline = self.tmp / "baseline.json"
        baseline.write_text(json.dumps(self.replay(golden)), "utf-8")
        res = self.client.post("/v1/convai/replay",
                               json={"recording": str(golden),
                                     "compare_to": str(baseline)})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertIn("comparison", res.json())

    def test_a_missing_baseline_is_a_404_not_a_silent_run(self) -> None:
        res = self.client.post("/v1/convai/replay",
                               json={"recording": str(self.golden()),
                                     "compare_to": str(self.tmp / "nope.json")})
        self.assertEqual(res.status_code, 404)

    def test_an_unknown_recording_is_a_404(self) -> None:
        res = self.client.post("/v1/convai/replay", json={"recording": "ghost"})
        self.assertEqual(res.status_code, 404)
        self.assertIn("CONVAI_RECORD", res.json()["detail"])

    def test_a_second_replay_is_refused_rather_than_queued(self) -> None:
        self.golden()
        with gym._REPLAY_LOCK:
            res = self.client.post("/v1/convai/replay",
                                   json={"recording": "two-turns"})
        self.assertEqual(res.status_code, 409)
        self.assertIn("already replaying", res.json()["detail"])

    def test_a_disabled_service_says_so(self) -> None:
        gym.SETTINGS = dataclasses.replace(gym.SETTINGS, convai_enabled=False)
        res = self.client.post("/v1/convai/replay", json={"recording": "x"})
        self.assertEqual(res.status_code, 503)
        self.assertIn("CONVAI_ENABLED", res.json()["detail"])

    def test_the_pace_is_validated_not_trusted(self) -> None:
        res = self.client.post("/v1/convai/replay",
                               json={"recording": "x", "pace": 99})
        self.assertEqual(res.status_code, 422)


class CompareEndpointTests(unittest.TestCase):
    """POST /v1/convai/compare - pure arithmetic, so no _GymCase machinery."""

    def setUp(self) -> None:
        host = FastAPI()
        host.include_router(gym.router)
        self.client = TestClient(host, raise_server_exceptions=False)

    def test_two_artifacts_in_the_body_are_scored(self) -> None:
        res = self.client.post("/v1/convai/compare",
                               json={"a": make_run(), "b": make_run()})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["verdict"], "pass")
        self.assertEqual(res.json()["schema"], gym.COMPARE_SCHEMA)

    def test_a_non_run_artifact_names_the_wrong_side(self) -> None:
        res = self.client.post("/v1/convai/compare",
                               json={"a": make_run(),
                                     "b": {"schema": gym.COMPARE_SCHEMA}})
        self.assertEqual(res.status_code, 422)
        self.assertIn("'b'", res.json()["detail"])
        self.assertIn(gym.RUN_SCHEMA, res.json()["detail"])

    def test_thresholds_are_honoured_per_call(self) -> None:
        slower = make_run()
        slower["turns"][1]["answer_s"] = 2.0
        slower["totals"] = gym._totals(slower["turns"], 3.0, {"audio": 4})
        res = self.client.post(
            "/v1/convai/compare",
            json={"a": make_run(), "b": slower,
                  "thresholds": {"answer_s_regression_abs_max_s": 5.0}})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["verdict"], "pass")

    def test_an_unknown_threshold_is_refused_by_name(self) -> None:
        res = self.client.post(
            "/v1/convai/compare",
            json={"a": make_run(), "b": make_run(),
                  "thresholds": {"wer_dirft_max": 0.1}})
        self.assertEqual(res.status_code, 422)
        self.assertIn("wer_dirft_max", res.json()["detail"])

    def test_a_non_numeric_threshold_is_a_422_not_a_500(self) -> None:
        res = self.client.post(
            "/v1/convai/compare",
            json={"a": make_run(), "b": make_run(),
                  "thresholds": {"wer_drift_max": "loose"}})
        self.assertEqual(res.status_code, 422)


class CliTests(_GymCase):
    """The console half: exit codes like certify.py, and ASCII-only output."""

    def _run_cli(self, argv) -> tuple[int, str]:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = gym.main(argv)
        return code, buf.getvalue()

    def _artifact(self, name: str, run: dict) -> str:
        path = self.tmp / name
        path.write_text(json.dumps(run), "utf-8")
        return str(path)

    def _captured_run(self, argv) -> dict:
        """`run` with the driver stubbed - what matters here is the ARGUMENTS
        the CLI decided on, not another minute of replaying."""
        seen: dict = {}
        real = gym.replay

        def fake(source, **kwargs):
            seen.update(kwargs, source=source)
            return make_run()

        gym.replay = fake
        try:
            self._run_cli(argv)
        finally:
            gym.replay = real
        return seen

    def test_run_defaults_to_the_same_pace_the_api_and_library_use(self) -> None:
        """One default experiment everywhere. A CLI that quietly ran in real
        time produced runs nobody could compare with the baselines the suite
        and POST /v1/convai/replay mint at pace 0."""
        self.assertEqual(self._captured_run(["run", "x"])["pace"], 0.0)
        self.assertEqual(gym.ReplayRequest(recording="x").pace, 0.0)
        self.assertEqual(gym.replay.__kwdefaults__["pace"], 0.0)

    def test_run_still_takes_real_time_when_it_is_asked_to(self) -> None:
        self.assertEqual(
            self._captured_run(["run", "x", "--pace", "1"])["pace"], 1.0)

    def test_compare_exits_zero_on_a_match(self) -> None:
        a = self._artifact("a.json", make_run())
        code, out = self._run_cli(["compare", a, a])
        self.assertEqual(code, 0)
        self.assertIn("PASS", out)

    def test_compare_exits_two_on_a_regression(self) -> None:
        slower = make_run()
        slower["turns"][1]["answer_s"] = 5.0
        slower["totals"] = gym._totals(slower["turns"], 3.0, {"audio": 4})
        code, out = self._run_cli(["compare", self._artifact("a.json", make_run()),
                                   self._artifact("b.json", slower)])
        self.assertEqual(code, 2)
        self.assertIn("FAIL", out)

    def test_compare_writes_the_result_when_asked(self) -> None:
        a = self._artifact("a.json", make_run())
        out_path = self.tmp / "out" / "cmp.json"
        self._run_cli(["compare", a, a, "--out", str(out_path)])
        self.assertEqual(json.loads(out_path.read_text("utf-8"))["verdict"], "pass")

    def test_a_missing_artifact_is_a_usage_failure_not_a_verdict(self) -> None:
        code, out = self._run_cli(["compare", str(self.tmp / "no.json"),
                                   str(self.tmp / "no2.json")])
        self.assertEqual(code, 1)
        self.assertIn("not a readable run artifact", out)

    def test_every_printed_line_is_ascii(self) -> None:
        """The console on the build box is cp1252; a report must survive it."""
        run = self.replay(self.golden())
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            gym._print_run(run)
        printed = buf.getvalue()
        printed.encode("ascii")   # raises if anything sneaked in
        self.assertIn("Gravitone gym run", printed)

        _, compared = self._run_cli(["compare", self._artifact("a.json", run),
                                     self._artifact("b.json", run)])
        compared.encode("ascii")


if __name__ == "__main__":
    unittest.main()
