"""The external-call surface of ingest: retries, batching, budgets, accounting.

Every one of these functions had ZERO coverage — the largest untested surface in
the service, and the one that spends money. Nothing here touches the network:
`urllib.request.urlopen` (or `ingest._call`) is mocked throughout, and there are
no API keys on this machine.

What is proven: transient failures are retried with bounded backoff, permanent
ones are not, a job-wide budget stops a dead provider from being retried once
per segment, labelling is BATCHED (40 segments → 5 requests, was 40), escalation
to the pro model is capped and counted, and a segment that fails to extract is
distinguishable from one the classifier failed on.
"""
from __future__ import annotations

import email.message
import io
import json
import unittest
import urllib.error
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import ingest


# ── helpers ───────────────────────────────────────────────────────────────────
def _http_error(code: int, retry_after: str | None = None, body: bytes = b"nope"):
    hdrs = email.message.Message()
    if retry_after is not None:
        hdrs["Retry-After"] = retry_after
    return urllib.error.HTTPError("https://x", code, "err", hdrs, io.BytesIO(body))


class _Body:
    """Minimal stand-in for the urlopen context manager."""

    def __init__(self, data: bytes) -> None:
        self._data = data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self) -> bytes:
        return self._data


def _gemini_reply(labels: list[dict]) -> bytes:
    return json.dumps({"candidates": [{"content": {"parts": [
        {"text": json.dumps({"labels": labels})}]}}]}).encode()


def _write_wav(path: Path, frames: int = 2400) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * frames)


def _req() -> "ingest.urllib.request.Request":
    return ingest.urllib.request.Request("https://example.test/v1", data=b"{}")


# ── retry policy ──────────────────────────────────────────────────────────────
class RetryTests(unittest.TestCase):
    def test_transient_500_is_retried_then_succeeds(self) -> None:
        spend = ingest.Spend()
        seq = [_http_error(500), _Body(b"ok")]

        def fake_open(req, timeout=None):
            got = seq.pop(0)
            if isinstance(got, Exception):
                raise got
            return got

        with mock.patch.object(ingest.urllib.request, "urlopen", side_effect=fake_open), \
             mock.patch.object(ingest.time, "sleep") as slept:
            self.assertEqual(ingest._call(_req(), 5, "gemini", spend), b"ok")
        slept.assert_called_once()
        # BOTH attempts are charged: a retry costs what the call cost.
        self.assertEqual(spend.calls["gemini"], 2)
        self.assertEqual(spend.retries, 1)

    def test_429_and_timeout_are_transient(self) -> None:
        for err in (_http_error(429), TimeoutError("read timed out"),
                    urllib.error.URLError("connection reset")):
            with self.subTest(err=type(err).__name__):
                spend = ingest.Spend()
                seq = [err, _Body(b"ok")]

                def fake_open(req, timeout=None, seq=seq):
                    got = seq.pop(0)
                    if isinstance(got, Exception):
                        raise got
                    return got

                with mock.patch.object(ingest.urllib.request, "urlopen", side_effect=fake_open), \
                     mock.patch.object(ingest.time, "sleep"):
                    self.assertEqual(ingest._call(_req(), 5, "gemini", spend), b"ok")
                self.assertEqual(spend.retries, 1)

    def test_permanent_4xx_is_not_retried(self) -> None:
        spend = ingest.Spend()
        with mock.patch.object(ingest.urllib.request, "urlopen",
                               side_effect=_http_error(401, body=b"bad key")), \
             mock.patch.object(ingest.time, "sleep") as slept:
            with self.assertRaises(ingest.ExternalError) as ctx:
                ingest._call(_req(), 5, "elevenlabs", spend)
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(spend.calls["elevenlabs"], 1)   # paid for exactly once
        self.assertEqual(spend.retries, 0)
        slept.assert_not_called()

    def test_attempts_are_bounded_per_call(self) -> None:
        spend = ingest.Spend()
        with mock.patch.object(ingest.urllib.request, "urlopen",
                               side_effect=_http_error(503)), \
             mock.patch.object(ingest.time, "sleep"):
            with self.assertRaises(ingest.ExternalError):
                ingest._call(_req(), 5, "gemini", spend)
        self.assertEqual(spend.calls["gemini"], ingest.RETRY_ATTEMPTS)

    def test_backoff_is_bounded_and_honours_retry_after(self) -> None:
        self.assertEqual(ingest._backoff(1, None), ingest.RETRY_BASE_S)
        self.assertEqual(ingest._backoff(2, None), ingest.RETRY_BASE_S * 2)
        self.assertLessEqual(ingest._backoff(30, None), ingest.RETRY_MAX_S)
        self.assertEqual(ingest._backoff(1, 7.0), 7.0)
        # A server-chosen sleep is capped — it must not wedge the phase thread.
        hdrs = email.message.Message()
        hdrs["Retry-After"] = "99999"
        self.assertLessEqual(ingest._retry_after(hdrs), ingest.RETRY_MAX_S)
        self.assertIsNone(ingest._retry_after(email.message.Message()))

    def test_job_budget_stops_a_dead_provider_fast(self) -> None:
        # The point of a per-JOB budget: per-call attempts alone would let a
        # provider that is simply down be retried once per segment.
        spend = ingest.Spend(retry_budget=1)
        with mock.patch.object(ingest.urllib.request, "urlopen",
                               side_effect=_http_error(503)), \
             mock.patch.object(ingest.time, "sleep"):
            for _ in range(3):
                with self.assertRaises(ingest.ExternalError):
                    ingest._call(_req(), 5, "gemini", spend)
        self.assertEqual(spend.retries, 1)               # budget, not per call
        # 2 attempts for the first call (it got the one retry), 1 for each after.
        self.assertEqual(spend.calls["gemini"], 4)


class ElevenLabsTests(unittest.TestCase):
    def test_scribe_parses_and_retries(self) -> None:
        spend = ingest.Spend()
        seq = [_http_error(502), _Body(json.dumps({"words": [], "text": "hi"}).encode())]

        def fake_open(req, timeout=None):
            got = seq.pop(0)
            if isinstance(got, Exception):
                raise got
            return got

        with TemporaryDirectory() as td:
            clip = Path(td) / "clip.wav"
            _write_wav(clip)
            with mock.patch.object(ingest.urllib.request, "urlopen", side_effect=fake_open), \
                 mock.patch.object(ingest.time, "sleep"):
                out = ingest.scribe(clip, spend)
        self.assertEqual(out["text"], "hi")
        self.assertEqual(spend.calls[ingest.ELEVEN], 2)

    def test_voice_isolate_writes_bytes_and_retries(self) -> None:
        spend = ingest.Spend()
        seq = [_http_error(500), _Body(b"ID3-mp3-bytes")]

        def fake_open(req, timeout=None):
            got = seq.pop(0)
            if isinstance(got, Exception):
                raise got
            return got

        with TemporaryDirectory() as td:
            src, dst = Path(td) / "a.wav", Path(td) / "iso.mp3"
            _write_wav(src)
            with mock.patch.object(ingest.urllib.request, "urlopen", side_effect=fake_open), \
                 mock.patch.object(ingest.time, "sleep"):
                ingest.voice_isolate(src, dst, spend)
            self.assertEqual(dst.read_bytes(), b"ID3-mp3-bytes")
        self.assertEqual(spend.calls[ingest.ELEVEN], 2)


# ── batching ──────────────────────────────────────────────────────────────────
class BatchShapeTests(unittest.TestCase):
    def test_forty_segments_fit_the_documented_batch_size(self) -> None:
        groups = ingest._batches(40, size=8, workers=4)
        self.assertEqual(len(groups), 5)
        self.assertEqual(sum(len(g) for g in groups), 40)

    def test_small_jobs_still_fill_the_pool(self) -> None:
        # Batching must not make an 8-segment job one serial request.
        groups = ingest._batches(8, size=8, workers=4)
        self.assertEqual(len(groups), 4)
        self.assertEqual(ingest._batches(1, size=8, workers=4), [[0]])
        self.assertEqual(ingest._batches(0), [])

    def test_indices_are_complete_and_ordered(self) -> None:
        flat = [i for g in ingest._batches(37, size=8, workers=4) for i in g]
        self.assertEqual(flat, list(range(37)))


class GeminiBatchTests(unittest.TestCase):
    def _wavs(self, td: str, n: int) -> list[Path]:
        out = []
        for i in range(n):
            p = Path(td) / f"seg_{i}.wav"
            _write_wav(p)
            out.append(p)
        return out

    def test_one_request_carries_every_clip(self) -> None:
        seen = {}

        def fake_call(req, timeout, provider, spend):
            body = json.loads(req.data)
            seen["clips"] = sum(1 for p in body["contents"][0]["parts"] if "inline_data" in p)
            seen["calls"] = seen.get("calls", 0) + 1
            return _gemini_reply([{"index": i, "emotion": "happy", "confidence": 0.9,
                                   "cue": "c"} for i in range(seen["clips"])])

        with TemporaryDirectory() as td:
            with mock.patch.object(ingest, "_call", side_effect=fake_call):
                out = ingest._gemini(ingest.FLASH_MODEL, self._wavs(td, 6))
        self.assertEqual(seen, {"clips": 6, "calls": 1})
        self.assertEqual([r["emotion"] for r in out], ["happy"] * 6)

    def test_reply_is_matched_by_index_not_position(self) -> None:
        rows = [{"index": 2, "emotion": "sad", "confidence": 0.8, "cue": "c"},
                {"index": 0, "emotion": "angry", "confidence": 0.8, "cue": "c"},
                {"index": 1, "emotion": "happy", "confidence": 0.8, "cue": "c"}]
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest, "_call", return_value=_gemini_reply(rows)):
                out = ingest._gemini(ingest.FLASH_MODEL, self._wavs(td, 3))
        self.assertEqual([r["emotion"] for r in out], ["angry", "happy", "sad"])

    def test_missing_or_junk_entries_degrade_only_themselves(self) -> None:
        rows = [{"index": 0, "emotion": "happy", "confidence": 0.9, "cue": "c"},
                {"index": 2, "emotion": "not_an_emotion", "confidence": "x", "cue": "c"}]
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest, "_call", return_value=_gemini_reply(rows)):
                out = ingest._gemini(ingest.FLASH_MODEL, self._wavs(td, 3))
        self.assertEqual(out[0]["emotion"], "happy")
        self.assertIsNone(out[1])                        # the model skipped it
        self.assertEqual(out[2]["emotion"], ingest.BASELINE)  # unknown → baseline
        self.assertEqual(out[2]["confidence"], 0.0)      # unparseable → 0

    def test_non_list_reply_is_a_permanent_error(self) -> None:
        bad = json.dumps({"candidates": [{"content": {"parts": [{"text": "\"nope\""}]}}]}).encode()
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest, "_call", return_value=bad):
                with self.assertRaises(ingest.ExternalError):
                    ingest._gemini(ingest.FLASH_MODEL, self._wavs(td, 2))


# ── escalation budget ─────────────────────────────────────────────────────────
class EscalationTests(unittest.TestCase):
    def _wavs(self, td: str, n: int) -> list[Path]:
        out = []
        for i in range(n):
            p = Path(td) / f"seg_{i}.wav"
            _write_wav(p)
            out.append(p)
        return out

    def _calls(self, low_conf: float = 0.3):
        """A fake `_call` answering flash with `low_conf` and pro with 0.95."""
        log: list[str] = []

        def fake_call(req, timeout, provider, spend):
            model = req.full_url.split("/models/")[1].split(":")[0]
            log.append(model)
            n = sum(1 for p in json.loads(req.data)["contents"][0]["parts"]
                    if "inline_data" in p)
            conf = 0.95 if model == ingest.PRO_MODEL else low_conf
            emo = "sad" if model == ingest.PRO_MODEL else "happy"
            return _gemini_reply([{"index": i, "emotion": emo, "confidence": conf,
                                   "cue": "c"} for i in range(n)])

        return log, fake_call

    def test_low_confidence_escalates_and_reports_the_pro_model(self) -> None:
        log, fake_call = self._calls()
        spend = ingest.Spend()
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest, "_call", side_effect=fake_call):
                out = ingest.label_emotions(self._wavs(td, 3), spend)
        self.assertEqual(log, [ingest.FLASH_MODEL, ingest.PRO_MODEL])  # ONE pro call
        self.assertEqual([r["model"] for r in out], [ingest.PRO_MODEL] * 3)
        self.assertEqual([r["escalation"] for r in out], ["escalated"] * 3)
        self.assertEqual(spend.escalated, 3)

    def test_confident_labels_never_escalate(self) -> None:
        log, fake_call = self._calls(low_conf=0.99)
        spend = ingest.Spend()
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest, "_call", side_effect=fake_call):
                out = ingest.label_emotions(self._wavs(td, 4), spend)
        self.assertEqual(log, [ingest.FLASH_MODEL])
        self.assertEqual(spend.escalated, 0)
        self.assertTrue(all(r["model"] == ingest.FLASH_MODEL for r in out))

    def test_escalation_is_capped_by_the_job_budget(self) -> None:
        log, fake_call = self._calls()
        spend = ingest.Spend(escalation_budget=2)
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest, "_call", side_effect=fake_call):
                out = ingest.label_emotions(self._wavs(td, 5), spend)
        self.assertEqual(spend.escalated, 2)
        self.assertEqual(spend.escalations_skipped, 3)
        self.assertEqual([r["escalation"] for r in out],
                         ["escalated", "escalated", "skipped", "skipped", "skipped"])
        # The three capped clips keep the flash label and SAY that is what they are.
        self.assertTrue(all(r["model"] == ingest.FLASH_MODEL for r in out[2:]))

    def test_a_failed_escalation_never_claims_the_wrong_source(self) -> None:
        # The old code swallowed the escalation exception and returned a label
        # indistinguishable from a confident flash one.
        calls: list[str] = []

        def fake_call(req, timeout, provider, spend):
            model = req.full_url.split("/models/")[1].split(":")[0]
            calls.append(model)
            if model == ingest.PRO_MODEL:
                raise ingest.ExternalError("gemini", 429, "rate limited")
            n = sum(1 for p in json.loads(req.data)["contents"][0]["parts"]
                    if "inline_data" in p)
            return _gemini_reply([{"index": i, "emotion": "happy", "confidence": 0.2,
                                   "cue": "c"} for i in range(n)])

        spend = ingest.Spend()
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest, "_call", side_effect=fake_call):
                out = ingest.label_emotions(self._wavs(td, 2), spend)
        self.assertEqual(calls, [ingest.FLASH_MODEL, ingest.PRO_MODEL])
        self.assertEqual([r["model"] for r in out], [ingest.FLASH_MODEL] * 2)
        self.assertEqual([r["escalation"] for r in out], ["failed"] * 2)
        self.assertEqual(spend.escalations_failed, 2)


# ── whole-phase call counts + degradation ─────────────────────────────────────
def _seg(i: int) -> dict:
    return {"speaker": "speaker_0", "start": float(i), "end": float(i) + 1.0,
            "text": f"line {i}"}


class LabelPhaseSpendTests(unittest.TestCase):
    def _work(self, td: str, n: int) -> Path:
        wd = Path(td)
        _write_wav(wd / "clean.wav")
        (wd / "segments.json").write_text(json.dumps([_seg(i) for i in range(n)]), "utf-8")
        return wd

    @staticmethod
    def _fake_to_wav(src, dst, a=None, b=None):
        _write_wav(Path(dst), 240)

    def test_forty_segments_cost_five_requests_not_forty(self) -> None:
        log: list[tuple[str, int]] = []

        def fake_call(req, timeout, provider, spend):
            model = req.full_url.split("/models/")[1].split(":")[0]
            n = sum(1 for p in json.loads(req.data)["contents"][0]["parts"]
                    if "inline_data" in p)
            log.append((model, n))
            spend.charge(provider)   # _call charges; we replaced it
            return _gemini_reply([{"index": i, "emotion": "happy", "confidence": 0.95,
                                   "cue": "c"} for i in range(n)])

        spend = ingest.Spend()
        with TemporaryDirectory() as td:
            wd = self._work(td, 40)
            with mock.patch.object(ingest, "to_wav", side_effect=self._fake_to_wav), \
                 mock.patch.object(ingest, "_call", side_effect=fake_call):
                res = ingest.label_and_stem(wd, "speaker_0", mode="cloud", spend=spend)
        # BEFORE: one request per segment = 40 (plus up to 40 more escalations).
        self.assertEqual(len(log), 5)
        self.assertEqual(sum(n for _, n in log), 40)     # every segment labelled
        self.assertEqual(len(res["segments"]), 40)
        self.assertEqual(res["spend"]["calls"]["gemini"], 5)
        self.assertEqual(res["spend"]["escalated"], 0)

    def test_escalation_stays_inside_the_budget_for_a_whole_job(self) -> None:
        def fake_call(req, timeout, provider, spend):
            model = req.full_url.split("/models/")[1].split(":")[0]
            n = sum(1 for p in json.loads(req.data)["contents"][0]["parts"]
                    if "inline_data" in p)
            spend.charge(provider)
            conf = 0.95 if model == ingest.PRO_MODEL else 0.2
            return _gemini_reply([{"index": i, "emotion": "happy", "confidence": conf,
                                   "cue": "c"} for i in range(n)])

        spend = ingest.Spend(escalation_budget=12)
        with TemporaryDirectory() as td:
            wd = self._work(td, 40)
            with mock.patch.object(ingest, "to_wav", side_effect=self._fake_to_wav), \
                 mock.patch.object(ingest, "_call", side_effect=fake_call):
                res = ingest.label_and_stem(wd, "speaker_0", mode="cloud", spend=spend)
        self.assertEqual(spend.escalated, 12)            # the cap, exactly
        self.assertEqual(spend.escalations_skipped, 28)
        # 5 flash + at most one pro request per flash batch — never 80 calls.
        self.assertLessEqual(res["spend"]["calls"]["gemini"], 10)
        self.assertEqual(res["spend"]["escalation_budget"], 12)

    def test_extract_failure_and_classifier_failure_are_told_apart(self) -> None:
        # Both used to collapse into the same silent fallback to baseline.
        def flaky_to_wav(src, dst, a=None, b=None):
            if Path(dst).stem.endswith("001"):
                raise RuntimeError("ffmpeg could not decode this span")
            _write_wav(Path(dst), 240)

        def fake_label(wav_paths, spend=None):
            return [None if Path(p).stem.endswith("002") else
                    {"emotion": "happy", "confidence": 0.9, "cue": "c",
                     "model": "flash"} for p in wav_paths]

        partials: list[dict] = []
        with TemporaryDirectory() as td:
            wd = self._work(td, 4)
            with mock.patch.object(ingest, "to_wav", side_effect=flaky_to_wav), \
                 mock.patch.object(ingest, "label_emotions", side_effect=fake_label):
                res = ingest.label_and_stem(wd, "speaker_0", mode="cloud",
                                            partial=partials.append)
        kinds = sorted(str(s["failure"]) for s in res["segments"])
        self.assertEqual(kinds, ["None", "None", "classify", "extract"])
        last = partials[-1]
        self.assertEqual(last["extract_errors"], 1)
        self.assertEqual(last["classify_errors"], 1)
        self.assertEqual(last["label_errors"], 2)        # the total the UI shows
        # Live cost is reported as it is spent, not only at the end.
        self.assertIn("spend", last)

    def test_total_classifier_outage_says_so_instead_of_no_speech(self) -> None:
        # Splicing nothing raises "no speech detected in the clip" — a lie when
        # the recording was fine and the classifier was down.
        def fake_call(req, timeout, provider, spend):
            raise ingest.ExternalError("gemini", 429, "rate limited")

        with TemporaryDirectory() as td:
            wd = self._work(td, 4)
            with mock.patch.object(ingest, "to_wav", side_effect=self._fake_to_wav), \
                 mock.patch.object(ingest, "_call", side_effect=fake_call):
                with self.assertRaises(ingest.UserFacing) as ctx:
                    ingest.label_and_stem(wd, "speaker_0", mode="cloud")
        msg = str(ctx.exception)
        self.assertIn("could not be classified", msg)
        self.assertNotIn("no speech detected", msg)

    def test_sovereign_mode_spends_nothing(self) -> None:
        spend = ingest.Spend()
        with TemporaryDirectory() as td:
            wd = self._work(td, 6)
            with mock.patch.object(ingest, "to_wav", side_effect=self._fake_to_wav), \
                 mock.patch.object(ingest, "_call") as call:
                res = ingest.label_and_stem(wd, "speaker_0", mode="sovereign", spend=spend)
        call.assert_not_called()
        self.assertEqual(res["spend"]["total_calls"], 0)
        self.assertTrue(all(s["model"] == "local" for s in res["segments"]))


if __name__ == "__main__":
    unittest.main()
