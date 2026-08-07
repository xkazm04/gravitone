"""What a conversation leaves behind, and whether it lines up.

The load-bearing claim is the timeline: ``user.wav`` and ``agent.wav`` are two
tracks of ONE recording, so sample N of each is the same instant. The agent's
audio is transmitted far faster than it plays, so this is not something that
happens by writing bytes as they go — it is padding, and it is what these cases
check.
"""
from __future__ import annotations

import dataclasses
import json
import tempfile
import unittest
import wave
from pathlib import Path

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod  # noqa: E402
from service import convai, recording, stt  # noqa: E402
from service.recording import Recorder, Turn  # noqa: E402
from service.tests.test_convai_protocol import ConversationTests, heard  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

RATE = 16000


def pcm(seconds: float, value: int = 1000) -> bytes:
    return int(value).to_bytes(2, "little", signed=True) * int(RATE * seconds)


def wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return round(w.getnframes() / w.getframerate(), 3)


class _RecordingCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._orig = recording.SETTINGS
        recording.SETTINGS = dataclasses.replace(
            recording.SETTINGS, convai_record=True,
            convai_recordings_dir=self._tmp.name)

    def tearDown(self) -> None:
        recording.SETTINGS = self._orig
        self._tmp.cleanup()

    def dir_for(self, conversation_id: str) -> Path:
        return Path(self._tmp.name) / conversation_id


class RecorderTests(_RecordingCase):
    def test_disabled_writes_nothing_at_all(self) -> None:
        rec = Recorder("off1", RATE, enabled=False)
        rec.heard(pcm(1.0))
        rec.spoke(pcm(1.0))
        rec.turn(Turn(role="agent", text="hi", at_s=0.0))
        rec.close()
        self.assertFalse(self.dir_for("off1").exists())

    def test_the_two_tracks_share_one_timeline(self) -> None:
        """The whole point: the agent's reply lands where it was HEARD."""
        rec = Recorder("aligned", RATE)
        rec.heard(pcm(3.0))          # the caller talks for 3s
        rec.spoke(pcm(2.0))          # then the agent answers, sent instantly
        rec.close()
        d = self.dir_for("aligned")
        self.assertEqual(wav_seconds(d / "user.wav"), 3.0)
        # 3s of silence while the caller spoke, THEN the 2s reply.
        self.assertEqual(wav_seconds(d / "agent.wav"), 5.0)

    def test_a_reply_is_not_re_padded_mid_turn(self) -> None:
        """Chunks of one reply are contiguous; only its START is placed."""
        rec = Recorder("contig", RATE)
        rec.heard(pcm(1.0))
        rec.spoke(pcm(0.5))
        rec.spoke(pcm(0.5))          # same turn, no caller audio in between
        rec.close()
        self.assertEqual(wav_seconds(self.dir_for("contig") / "agent.wav"), 2.0)

    def test_audio_that_arrives_while_the_agent_talks_keeps_its_place(self) -> None:
        rec = Recorder("overlap", RATE)
        rec.heard(pcm(1.0))
        rec.spoke(pcm(2.0))          # agent speaks 1.0 -> 3.0
        rec.heard(pcm(1.0))          # caller's mic keeps running: 1.0 -> 2.0
        rec.spoke(pcm(1.0))          # still ahead of the mic, so no new padding
        rec.close()
        d = self.dir_for("overlap")
        self.assertEqual(wav_seconds(d / "user.wav"), 2.0)
        self.assertEqual(wav_seconds(d / "agent.wav"), 4.0)

    def test_the_transcript_records_what_each_turn_cost(self) -> None:
        rec = Recorder("costs", RATE)
        rec.note(agent_id="local-interviewer", brain={"backend": "scripted"})
        rec.turn(Turn(role="candidate", text="hello", at_s=0.5, audio_s=1.2,
                      transcribe_s=0.4))
        rec.turn(Turn(role="agent", text="hi there", at_s=2.0, answer_s=0.9))
        rec.close("hung_up")

        body = json.loads((self.dir_for("costs") / "transcript.json").read_text("utf-8"))
        self.assertEqual(body["conversation_id"], "costs")
        self.assertEqual(body["ended"], "hung_up")
        self.assertEqual([t["role"] for t in body["turns"]], ["candidate", "agent"])
        self.assertEqual(body["turns"][0]["transcribe_s"], 0.4)
        self.assertEqual(body["turns"][1]["answer_s"], 0.9)
        meta = json.loads((self.dir_for("costs") / "meta.json").read_text("utf-8"))
        self.assertEqual(meta["agent_id"], "local-interviewer")
        self.assertEqual(meta["ended"], "hung_up")

    def test_closing_twice_is_harmless(self) -> None:
        rec = Recorder("twice", RATE)
        rec.heard(pcm(0.5))
        rec.close()
        rec.close()
        self.assertTrue((self.dir_for("twice") / "transcript.json").is_file())

    def test_a_call_that_died_still_left_its_audio(self) -> None:
        """Incremental writes are the point: no transcript, but the audio is there."""
        rec = Recorder("died", RATE)
        rec.heard(pcm(2.0))
        # No close() — the process was killed.
        self.assertTrue((self.dir_for("died") / "user.wav").is_file())


class RetentionTests(_RecordingCase):
    def test_the_oldest_recordings_are_evicted(self) -> None:
        for i in range(5):
            rec = Recorder(f"conv{i}", RATE)
            rec.heard(pcm(0.1))
            rec.close()
        recording.evict_oldest(limit=2)
        left = sorted(p.name for p in Path(self._tmp.name).iterdir())
        self.assertEqual(len(left), 2)
        self.assertEqual(left, ["conv3", "conv4"])  # the newest survive

    def test_listing_is_newest_first_and_carries_the_summary(self) -> None:
        for i in range(3):
            rec = Recorder(f"c{i}", RATE)
            rec.note(agent_id="local-interviewer", turns=i)
            rec.heard(pcm(0.1))
            rec.close("hung_up")
        found = recording.listing()
        self.assertEqual([e["conversation_id"] for e in found], ["c2", "c1", "c0"])
        self.assertEqual(found[0]["status"], "complete")
        self.assertEqual(found[0]["agent_id"], "local-interviewer")
        self.assertIn("user.wav", found[0]["audio"])

    def test_an_unfinished_call_is_listed_as_in_progress(self) -> None:
        Recorder("live", RATE).heard(pcm(0.1))
        found = recording.listing()
        self.assertEqual(found[0]["status"], "in_progress")

    def test_a_missing_directory_is_not_an_error(self) -> None:
        recording.SETTINGS = dataclasses.replace(
            recording.SETTINGS, convai_recordings_dir=self._tmp.name + "/nope")
        self.assertEqual(recording.listing(), [])
        self.assertEqual(recording.evict_oldest(), 0)
        self.assertIsNone(recording.load("anything"))


class TranscriptLookupTests(_RecordingCase):
    def test_a_path_traversing_id_is_refused_not_resolved(self) -> None:
        for hostile in ("../../etc/passwd", "a/b", "..", "", "with-dash"):
            self.assertIsNone(recording.load(hostile), hostile)

    def test_a_real_id_round_trips(self) -> None:
        rec = Recorder("abc123", RATE)
        rec.turn(Turn(role="agent", text="hello", at_s=0.0))
        rec.close()
        self.assertEqual(recording.load("abc123")["turns"][0]["text"], "hello")


class RecordedConversationTests(ConversationTests, _RecordingCase):
    """A real socket session, recorded — the artifacts a test run leaves."""

    def setUp(self) -> None:
        ConversationTests.setUp(self)
        _RecordingCase.setUp(self)
        self._orig_convai = convai.SETTINGS
        convai.SETTINGS = recording.SETTINGS

    def tearDown(self) -> None:
        convai.SETTINGS = self._orig_convai
        _RecordingCase.tearDown(self)
        ConversationTests.tearDown(self)

    def test_a_conversation_leaves_audio_and_a_readable_transcript(self) -> None:
        self._engine()
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            meta = ws.receive_json()
            conversation_id = meta["conversation_initiation_metadata_event"]["conversation_id"]
            self._speak(ws)
            self._until(ws, "user_transcript")
            self._until(ws, "agent_response")
            ws.receive_json()  # one audio event, so the agent track is non-empty

        d = self.dir_for(conversation_id)
        self.assertTrue((d / "user.wav").is_file())
        self.assertGreater(wav_seconds(d / "user.wav"), 1.0)

        body = json.loads((d / "transcript.json").read_text("utf-8"))
        roles = [t["role"] for t in body["turns"]]
        self.assertEqual(roles[:2], ["candidate", "agent"])
        candidate = body["turns"][0]
        self.assertEqual(candidate["text"], self.heard_texts[0])
        self.assertGreater(candidate["audio_s"], 0)
        self.assertIsNotNone(candidate["transcribe_s"])

        served = self.client.get(f"/v1/convai/conversations/{conversation_id}")
        self.assertEqual(served.status_code, 200)
        self.assertEqual(served.json()["turns"][0]["text"], self.heard_texts[0])

    def test_an_unknown_conversation_says_recording_might_be_off(self) -> None:
        self._engine()
        res = self.client.get("/v1/convai/conversations/doesnotexist")
        self.assertEqual(res.status_code, 404)
        self.assertIn("CONVAI_RECORD", res.json()["detail"])

    def test_a_recorded_track_is_served_for_listening(self) -> None:
        self._engine()
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            meta = ws.receive_json()
            conversation_id = meta["conversation_initiation_metadata_event"]["conversation_id"]
            self._speak(ws)
            self._until(ws, "agent_response")
            ws.receive_json()  # one audio event, so the agent track is non-empty

        for track in ("user", "agent"):
            res = self.client.get(
                f"/v1/convai/conversations/{conversation_id}/audio/{track}")
            self.assertEqual(res.status_code, 200, track)
            self.assertEqual(res.headers["content-type"], "audio/wav")
            self.assertEqual(res.content[:4], b"RIFF", track)

    def test_audio_refuses_hostile_ids_and_unknown_tracks(self) -> None:
        self._engine()
        hostile = self.client.get(
            "/v1/convai/conversations/..%2F..%2Fetc/audio/user")
        self.assertEqual(hostile.status_code, 404)
        wrong = self.client.get(
            "/v1/convai/conversations/abc123/audio/transcript")
        self.assertEqual(wrong.status_code, 404)
        self.assertIn("track", wrong.json()["detail"])


if __name__ == "__main__":
    unittest.main()
