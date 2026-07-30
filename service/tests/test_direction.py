"""Direction corpus — what humans change when they re-perform a take.

The counting rule and the bounded store are tested here; the wiring from a
derived take lives in test_takes_reviews. The endpoint is exercised on a bare
app that includes only this router, so the test states the contract without
depending on where the app mounts it.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from service.tests import fake_engine  # installs shims — must precede app import

import service.direction as direction
from fastapi import FastAPI
from fastapi.testclient import TestClient


def take(cid: str, *emotions: str) -> dict:
    return {
        "character_id": cid,
        "segments": [{"text": "line", "requested": e, "used": e} for e in emotions],
    }


class DirectionStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._orig = direction.DIRECTION_PATH
        direction.DIRECTION_PATH = Path(self._td.name) / "direction_deltas.json"
        app = FastAPI()
        app.include_router(direction.router)
        self.client = TestClient(app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        direction.DIRECTION_PATH = self._orig
        self._td.cleanup()

    def _stats(self) -> dict:
        resp = self.client.get("/v1/direction/stats")
        self.assertEqual(resp.status_code, 200)
        return resp.json()

    def test_counts_the_line_that_moved_and_ignores_the_ones_that_did_not(self) -> None:
        parent = take("sarah", "baseline", "baseline", "sad")
        child = take("sarah", "baseline", "angry", "sad")
        self.assertEqual(direction.emotion_deltas(parent, child), [("baseline", "angry")])

        direction.record_delta(parent, child)
        direction.record_delta(parent, child)
        body = self._stats()
        self.assertEqual(body["characters"], [{
            "character_id": "sarah", "children": 2, "changes": 2, "bounded": False,
            "top": [{"from": "baseline", "to": "angry", "count": 2}],
        }])

    def test_requested_beats_used_because_direction_is_the_instruction(self) -> None:
        # The parent ASKED for angry and fell back to baseline. A child that
        # asks for angry again changed nothing — counting `used` would invent a
        # "baseline -> angry" decision the human never made.
        parent = {"character_id": "s", "segments": [
            {"requested": "angry", "used": "baseline", "fallback": True}]}
        child = {"character_id": "s", "segments": [
            {"requested": "angry", "used": "angry"}]}
        self.assertEqual(direction.emotion_deltas(parent, child), [])

    def test_segments_pair_by_position_and_extra_lines_are_not_changes(self) -> None:
        parent = take("s", "baseline")
        child = take("s", "baseline", "angry", "sad")
        self.assertEqual(direction.emotion_deltas(parent, child), [])

    def test_character_swap_is_recorded_against_both_voices(self) -> None:
        direction.record_delta(take("sarah", "baseline"), take("tom", "baseline"))
        body = self._stats()
        self.assertEqual(body["swaps"], [{"from": "sarah", "to": "tom", "count": 1}])
        self.assertEqual([c["character_id"] for c in body["characters"]], ["tom"])

    def test_junk_emotions_are_not_counted(self) -> None:
        parent = {"character_id": "s", "segments": [{"requested": "BASELINE!!"}]}
        child = {"character_id": "s", "segments": [{"requested": "x" * 80}]}
        self.assertEqual(direction.emotion_deltas(parent, child), [])

    def test_never_raises_on_garbage(self) -> None:
        for bad in (None, "nope", 7, {"segments": "not a list"}):
            direction.record_delta(bad, bad)  # type: ignore[arg-type]
        self.assertEqual(self._stats()["characters"], [])

    def test_corrupt_store_is_reported_not_silently_zeroed(self) -> None:
        direction.DIRECTION_PATH.write_text("{not json", "utf-8")
        with self.assertLogs("service.direction", level="WARNING"):
            self.assertEqual(direction._load(), {"characters": {}, "swaps": {}})
        # and a later write still lands
        direction.record_delta(take("s", "baseline"), take("s", "angry"))
        self.assertEqual(self._stats()["characters"][0]["children"], 1)

    def test_store_is_bounded(self) -> None:
        direction.MAX_KEYS, orig = 2, direction.MAX_KEYS
        try:
            for emotion in ("angry", "sad", "happy"):
                direction.record_delta(take("s", "baseline"), take("s", emotion))
        finally:
            direction.MAX_KEYS = orig
        stored = json.loads(direction.DIRECTION_PATH.read_text("utf-8"))
        self.assertEqual(len(stored["characters"]["s"]["deltas"]), 2)
        # the take still counted even though its delta key did not fit
        self.assertEqual(stored["characters"]["s"]["children"], 3)

    def test_stats_filters_by_character_and_limits(self) -> None:
        direction.record_delta(take("a", "baseline"), take("a", "angry"))
        direction.record_delta(take("b", "baseline"), take("b", "sad"))
        body = self.client.get("/v1/direction/stats?character_id=b&limit=1").json()
        self.assertEqual([c["character_id"] for c in body["characters"]], ["b"])
        self.assertEqual(body["characters"][0]["top"][0]["to"], "sad")


if __name__ == "__main__":
    unittest.main()
