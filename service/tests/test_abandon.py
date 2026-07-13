"""Direction 1 — skip abandoned jobs + bounded (LRU) per-worker voice cache.

Proves against the REAL ``TtsEngine`` worker loop (driven by a fake, gated
pocket-tts model — never the real model): a queued job whose caller has given
up is skipped un-run, its permit is released immediately, it is counted as
``abandoned`` (not errored/completed) and its future is cancelled; and the
per-worker voice cache evicts least-recently-used entries at its cap.
"""
from __future__ import annotations

import sys
import threading
import time
import types
import unittest

from service.tests import fake_engine  # installs shims — must precede engine use

import service.engine as enginemod
from service.engine import TtsEngine, _Worker, _VOICE_CACHE_MAX


class _FakeAudio:
    """Minimal stand-in for a torch audio tensor (only what run() touches)."""

    def detach(self):
        return self

    def to(self, *a, **k):
        return self

    def squeeze(self):
        return self

    def numel(self):
        return 24000


class _StateModel:
    """A model that only serves voice states (for the LRU cache test)."""

    sample_rate = 24000

    def get_state_for_audio_prompt(self, source, truncate=True):
        return {"src": source}


class _GatedModel(_StateModel):
    """Fake model whose generate_audio blocks until released, so a test can
    hold a worker busy on one job while another sits queued."""

    def __init__(self) -> None:
        self.generated: list[str] = []
        self.gate = threading.Event()
        self.entered = threading.Event()

    def generate_audio(self, state, text, max_tokens, frames_after_eos, copy_state):
        self.generated.append(text)
        self.entered.set()
        self.gate.wait(5)
        return _FakeAudio()


class VoiceCacheLruTests(unittest.TestCase):
    def test_lru_eviction_at_cap(self) -> None:
        w = _Worker(0, None)  # engine unused by _voice_state
        w.model = _StateModel()
        for i in range(_VOICE_CACHE_MAX + 3):
            w._voice_state(f"voice{i}")
        # Bounded: never exceeds the cap.
        self.assertEqual(len(w._voice_cache), _VOICE_CACHE_MAX)
        # Oldest three evicted; newest retained.
        self.assertNotIn("voice0", w._voice_cache)
        self.assertNotIn("voice1", w._voice_cache)
        self.assertNotIn("voice2", w._voice_cache)
        self.assertIn(f"voice{_VOICE_CACHE_MAX + 2}", w._voice_cache)

    def test_touch_makes_mru_and_survives_eviction(self) -> None:
        w = _Worker(0, None)
        w.model = _StateModel()
        for i in range(_VOICE_CACHE_MAX):
            w._voice_state(f"voice{i}")
        # Touch the least-recently-used entry -> it becomes most-recently-used.
        w._voice_state("voice0")
        # Add a new voice: something must be evicted, but not the touched one.
        w._voice_state("new")
        self.assertIn("voice0", w._voice_cache)
        self.assertNotIn("voice1", w._voice_cache)  # now the LRU victim
        self.assertEqual(len(w._voice_cache), _VOICE_CACHE_MAX)


class AbandonSkipTests(unittest.TestCase):
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
        # Skip real audio serialization; run() only needs bytes back.
        enginemod.audio_to_wav_bytes = lambda audio, sr: b"WAV"
        self.model = _GatedModel()
        sys.modules["pocket_tts"].TTSModel = types.SimpleNamespace(
            load_model=lambda language, quantize: self.model
        )
        self.eng = TtsEngine()
        self.eng.start()

    def tearDown(self) -> None:
        # Ensure the worker isn't wedged on the gate before shutdown.
        self.model.gate.set()
        self.eng.stop()
        enginemod.SETTINGS = self._orig_settings
        enginemod.audio_to_wav_bytes = self._orig_wav
        sys.modules["pocket_tts"].TTSModel = self._orig_tts

    def test_abandoned_queued_job_is_skipped_permit_released(self) -> None:
        # Job A occupies the single worker and blocks inside generate_audio.
        job_a = self.eng.submit(voice_id="va", text="A")
        self.assertTrue(self.model.entered.wait(5), "worker never started job A")

        # Job B is now stuck behind A in the queue. The caller gives up.
        job_b = self.eng.submit(voice_id="vb", text="B")
        job_b.abandoned.set()

        # Release A; the worker finishes it, then reaches B and skips it.
        self.model.gate.set()

        deadline = time.time() + 5
        while not job_b.future.done() and time.time() < deadline:
            time.sleep(0.01)

        self.assertTrue(job_b.future.done())
        self.assertTrue(job_b.future.cancelled(), "abandoned future must be cancelled")
        # B never ran through the model; only A did.
        self.assertEqual(self.model.generated, ["A"])
        # Counted as abandoned, not errored/completed.
        self.assertEqual(self.eng.metrics.abandoned, 1)
        self.assertEqual(self.eng.metrics.errored, 0)
        self.assertEqual(self.eng.metrics.completed, 1)
        # Both admission permits released -> semaphore fully restored.
        self.assertEqual(self.eng._admit._value, self.eng._max_inflight)
        # Snapshot exposes the new counter alongside timeouts.
        snap = self.eng.metrics.snapshot()
        self.assertIn("abandoned", snap)
        self.assertIn("timeouts", snap)
        self.assertEqual(snap["abandoned"], 1)


if __name__ == "__main__":
    unittest.main()
