"""Direction 2 — graceful drain shutdown.

Proves against the REAL ``TtsEngine`` (driven by a gated fake pocket-tts model,
never the real model): ``stop()`` resolves EVERY pending future — the in-flight
job finishes with a result, queued jobs fail fast with ``ShuttingDown`` — joins
the workers so none stay alive, keeps the queue metric balanced and releases
every admission permit, and further submits are refused.
"""
from __future__ import annotations

import sys
import threading
import time
import types
import unittest

from service.tests import fake_engine  # installs shims — must precede engine use

import service.engine as enginemod
from service.engine import ShuttingDown, TtsEngine


class _FakeAudio:
    def detach(self):
        return self

    def to(self, *a, **k):
        return self

    def squeeze(self):
        return self

    def numel(self):
        return 24000


class _GatedModel:
    """generate_audio blocks until released, so a test can pin one job
    in-flight while the rest sit queued during shutdown."""

    sample_rate = 24000

    def __init__(self) -> None:
        self.generated: list[str] = []
        self.gate = threading.Event()
        self.entered = threading.Event()

    def get_state_for_audio_prompt(self, source, truncate=True):
        return {"src": source}

    def generate_audio(self, state, text, max_tokens, frames_after_eos, copy_state):
        self.generated.append(text)
        self.entered.set()
        self.gate.wait(5)
        return _FakeAudio()


class DrainShutdownTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_settings = enginemod.SETTINGS
        self._orig_wav = enginemod.audio_to_wav_bytes
        self._orig_tts = sys.modules["pocket_tts"].TTSModel
        real = self._orig_settings
        enginemod.SETTINGS = types.SimpleNamespace(
            workers=1, queue_max=8, torch_threads=1,
            language=real.language, quantize=real.quantize,
            default_voice=real.default_voice, voices_dir=real.voices_dir,
            max_tokens=real.max_tokens,
        )
        enginemod.audio_to_wav_bytes = lambda audio, sr: b"WAV"
        self.model = _GatedModel()
        sys.modules["pocket_tts"].TTSModel = types.SimpleNamespace(
            load_model=lambda language, quantize: self.model
        )
        self.eng = TtsEngine()
        self.eng.start()

    def tearDown(self) -> None:
        self.model.gate.set()
        try:
            self.eng.stop(drain_timeout_s=2)
        except Exception:
            pass
        enginemod.SETTINGS = self._orig_settings
        enginemod.audio_to_wav_bytes = self._orig_wav
        sys.modules["pocket_tts"].TTSModel = self._orig_tts

    def test_stop_resolves_all_futures_and_joins_workers(self) -> None:
        # One worker: job 0 goes in-flight (and blocks); jobs 1..4 queue up.
        jobs = [self.eng.submit(voice_id="v", text=f"j{i}") for i in range(5)]
        self.assertTrue(self.model.entered.wait(5), "worker never started job 0")

        # Shut down on a side thread — it will block joining the gated worker.
        stopper = threading.Thread(target=lambda: self.eng.stop(drain_timeout_s=5))
        stopper.start()

        # Queued jobs must fail fast, WITHOUT waiting for the in-flight one.
        deadline = time.time() + 5
        for j in jobs[1:]:
            while not j.future.done() and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue(j.future.done(), "queued future not resolved by drain")
            self.assertIsInstance(j.future.exception(), ShuttingDown)

        # The in-flight job is untouched and still running (drain never cancels
        # a live generation).
        self.assertFalse(jobs[0].future.done())

        # Let the in-flight generation finish; the worker then exits and stop()
        # returns.
        self.model.gate.set()
        stopper.join(timeout=5)
        self.assertFalse(stopper.is_alive(), "stop() did not return")

        # Every future resolved; the in-flight one carries a real result.
        self.assertTrue(all(j.future.done() for j in jobs))
        self.assertEqual(jobs[0].future.result().sample_rate, 24000)
        # Only the in-flight job ever reached the model.
        self.assertEqual(self.model.generated, ["j0"])

        # No worker left alive.
        self.assertFalse(any(w.is_alive() for w in self.eng._workers))

        # Accounting stays clean: queue drained to zero, all permits returned.
        self.assertEqual(self.eng.metrics.queued, 0)
        # Public accessor, not threading.Semaphore's private _value.
        self.assertEqual(self.eng.available_permits(), self.eng._max_inflight)

    def test_submit_after_stop_is_refused(self) -> None:
        self.model.gate.set()  # nothing should block
        self.eng.stop(drain_timeout_s=2)
        with self.assertRaises(ShuttingDown):
            self.eng.submit(voice_id="v", text="late")


class ShuttingDownHttpMappingTests(unittest.TestCase):
    """The app maps a submit refused during drain to HTTP 503 (not 500)."""

    def setUp(self) -> None:
        import service.app as appmod
        self.appmod = appmod
        self._orig_engine = appmod.ENGINE
        from fastapi.testclient import TestClient
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        self.appmod.ENGINE = self._orig_engine

    def test_submit_during_shutdown_returns_503(self) -> None:
        class _DrainingEngine:
            metrics = fake_engine._FakeMetrics()

            def submit(self, *a, **k):
                raise ShuttingDown("server shutting down")

        self.appmod.ENGINE = _DrainingEngine()
        resp = self.client.post(
            "/v1/text-to-speech/v",
            params={"output_format": "wav_24000"},
            json={"text": "hello"},
        )
        self.assertEqual(resp.status_code, 503)
        self.assertEqual(resp.headers.get("retry-after"), "1")


if __name__ == "__main__":
    unittest.main()
