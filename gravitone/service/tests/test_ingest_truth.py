"""What analyze LEARNS about a recording has to reach the client.

`sovereign_analyze` computes three things the user cannot get anywhere else —
the mode's own limits, the speech-detection outcome, and the levels that
outcome was decided on — and every one of them died at the API boundary: they
were never written into the job dict, and `_PUBLIC_KEYS` had no slot for them
even if they had been. The visible consequence was a studio that kept its own
hand-typed copy of the sovereign limits (free to drift) and a user whose `auto`
scan resolved to sovereign being told nothing about it.

No audio and no ffmpeg here: the pipeline call is mocked, because what is under
test is the boundary, not the pipeline.
"""
from __future__ import annotations

import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # noqa: F401 - installs shims before app import

import service.app as appmod
import service.ingest as ingest
import service.ingest_api as ingest_api
from fastapi.testclient import TestClient

DETECTION = {"outcome": "unbroken", "spans": 1, "speech_seconds": 12.0,
             "noise_floor_db": -61.0, "speech_db": -18.0, "threshold_db": -41.0,
             "adaptive": True}
NOTE = "no pauses were found in this recording, so the whole of it is used as one take."


class IngestTruthTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.client = TestClient(appmod.app, raise_server_exceptions=False)
        self._jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)
        self._dir.cleanup()

    def _job(self, mode: str) -> dict:
        wd = self.root / f"work-{mode}"
        wd.mkdir(exist_ok=True)
        job = {"id": mode, "status": "running", "step": None, "mode": mode,
               "steps": [{**s, "state": "pending"} for s in ingest_api.STEPS_BY_MODE[mode]],
               "partial": {}, "speakers": None, "duration": 0, "result": None,
               "error": None, "note": None, "limits": None, "detection": None,
               "work_dir": str(wd), "created": time.time(), "clip_sha256": "abc",
               "cancel": False, "committed": None}
        ingest_api.JOBS[mode] = job
        return job

    # ── the three fields cross the boundary ──────────────────────────────────
    def test_sovereign_note_limits_detection_are_persisted_and_served(self) -> None:
        job = self._job("sovereign")
        audio = self.root / "clip.wav"
        audio.write_bytes(b"RIFFfake")
        res = {"duration": 12.0, "transcript": "", "note": NOTE,
               "speakers": [{"id": "speaker_0", "utterances": 1, "seconds": 12.0,
                             "sample_text": "sovereign mode — one take"}],
               "limits": list(ingest.sovereign_limits()), "detection": DETECTION}
        with mock.patch.object(ingest, "sovereign_analyze", return_value=res):
            ingest_api._analyze("sovereign", audio)

        self.assertEqual(job["status"], "awaiting_speaker")
        # persisted in job state …
        self.assertEqual(job["note"], NOTE)
        self.assertEqual(job["limits"], list(ingest.sovereign_limits()))
        self.assertEqual(job["detection"], DETECTION)
        # … AND served (a key the job holds but _PUBLIC_KEYS omits is thrown away)
        body = self.client.get("/v1/ingest/sovereign").json()
        self.assertEqual(body["note"], NOTE)
        self.assertEqual(body["limits"], list(ingest.sovereign_limits()))
        self.assertEqual(body["detection"], DETECTION)
        self.assertEqual(body["detection"]["outcome"], "unbroken")

    def test_cloud_job_reports_the_fields_as_absent_not_missing(self) -> None:
        """Cloud analyze computes none of this. The client must be able to tell
        "this mode does not produce it" from "it has not been computed yet",
        so the keys are present and null rather than absent."""
        self._job("cloud")
        audio = self.root / "clip2.wav"
        audio.write_bytes(b"RIFFfake")
        res = {"duration": 9.0, "transcript": "hello",
               "speakers": [{"id": "speaker_0", "utterances": 2, "seconds": 9.0,
                             "sample_text": "hello there"}],
               "spend": {}}
        with mock.patch.object(ingest, "analyze", return_value=res):
            ingest_api._analyze("cloud", audio)
        body = self.client.get("/v1/ingest/cloud").json()
        for k in ("note", "limits", "detection"):
            self.assertIn(k, body)
            self.assertIsNone(body[k])

    # ── the limits have ONE source ───────────────────────────────────────────
    def test_modes_serves_the_backend_constant_itself(self) -> None:
        r = self.client.get("/v1/ingest/modes")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        # Equality with the live constant is the anti-drift test: the studio
        # renders exactly this, so a change to sovereign_limits() reaches the UI
        # without anyone re-typing it.
        self.assertEqual(body["sovereign"]["limits"], list(ingest.sovereign_limits()))
        self.assertEqual(body["sovereign"]["note"], ingest.sovereign_note())

    def test_modes_is_not_swallowed_by_the_job_route(self) -> None:
        """/{job_id} matches any string, so a /modes declared after it would
        answer "this ingest session has expired" forever."""
        r = self.client.get("/v1/ingest/modes")
        self.assertNotIn("detail", r.json())

    def test_modes_reports_which_mode_auto_will_resolve_to(self) -> None:
        with mock.patch.object(ingest, "have_cloud_keys", return_value=False):
            self.assertEqual(self.client.get("/v1/ingest/modes").json()["resolved_auto"],
                             "sovereign")
        with mock.patch.object(ingest, "have_cloud_keys", return_value=True):
            self.assertEqual(self.client.get("/v1/ingest/modes").json()["resolved_auto"],
                             "cloud")


if __name__ == "__main__":
    unittest.main()
