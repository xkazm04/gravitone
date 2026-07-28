"""The Arm inference-path pass: CPU tuning, grad-free generation, ffmpeg cap.

Every knob here is meant to be individually revertible from the environment, so
these tests assert BOTH directions: on (the shipped default) and off (the
pre-pass behaviour). torch is not installed on the build box, so the shim in
``fake_engine`` records what the engine asked the CPU-tuning API for — these
tests verify the REQUESTS and the fallback logic, not any speed claim. See
``benchmark_arm_ab.sh`` for the only place a speedup number may come from.
"""
from __future__ import annotations

import dataclasses
import sys
import threading
import types
import unittest

from service.tests import fake_engine  # installs shims — must precede engine use

import service.engine as enginemod
from service.engine import TtsEngine

torch = sys.modules["torch"]


class TuningSettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = enginemod.SETTINGS
        self._orig_infer = enginemod._INFERENCE_MODE_OK

    def tearDown(self) -> None:
        enginemod.SETTINGS = self._orig
        enginemod._INFERENCE_MODE_OK = self._orig_infer

    def _settings(self, **kw):
        enginemod.SETTINGS = dataclasses.replace(self._orig, **kw)

    def test_defaults_apply_threads_interop_and_flush_denormal(self) -> None:
        self._settings(torch_threads=3, torch_interop_threads=1,
                       flush_denormal=True, quantize=False)
        applied = enginemod._apply_cpu_tuning()
        self.assertEqual(torch._tuning["threads"], 3)
        self.assertEqual(torch._tuning["interop"], 1)
        self.assertIs(torch._tuning["flush_denormal"], True)
        self.assertEqual(applied["torch_threads"], 3)
        self.assertEqual(applied["torch_interop_threads"], 1)
        self.assertIs(applied["flush_denormal"], True)
        self.assertIsNone(applied["quantized_engine"])

    def test_every_knob_is_revertible(self) -> None:
        torch._tuning["interop"] = None
        torch._tuning["flush_denormal"] = None
        self._settings(torch_threads=2, torch_interop_threads=0,
                       flush_denormal=False, quantize=False)
        applied = enginemod._apply_cpu_tuning()
        # interop 0 / flush off => torch is never asked, i.e. the pre-pass path.
        self.assertIsNone(torch._tuning["interop"])
        self.assertIsNone(torch._tuning["flush_denormal"])
        self.assertIs(applied["flush_denormal"], False)

    def test_late_interop_call_is_survivable(self) -> None:
        # torch refuses set_num_interop_threads after the first parallel region.
        # A missed optimization must never fail start-up.
        orig = torch.set_num_interop_threads

        def boom(_n):
            raise RuntimeError("cannot set number of interop threads after ...")

        torch.set_num_interop_threads = boom
        self.addCleanup(setattr, torch, "set_num_interop_threads", orig)
        self._settings(torch_interop_threads=1, quantize=False)
        applied = enginemod._apply_cpu_tuning()  # must not raise
        self.assertIn("torch_interop_threads", applied)


class QuantizedEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = enginemod.SETTINGS
        self._orig_arch = enginemod.IS_AARCH64

    def tearDown(self) -> None:
        enginemod.SETTINGS = self._orig
        enginemod.IS_AARCH64 = self._orig_arch

    def _settings(self, **kw):
        enginemod.SETTINGS = dataclasses.replace(self._orig, **kw)

    def test_auto_prefers_qnnpack_on_aarch64(self) -> None:
        enginemod.IS_AARCH64 = True
        self._settings(quantized_engine="auto")
        self.assertEqual(enginemod._select_quantized_engine(), "qnnpack")

    def test_auto_leaves_non_arm_alone(self) -> None:
        enginemod.IS_AARCH64 = False
        self._settings(quantized_engine="auto")
        self.assertIsNone(enginemod._select_quantized_engine())

    def test_unsupported_explicit_engine_is_refused_not_forced(self) -> None:
        self._settings(quantized_engine="fbgemm")  # shim supports none/qnnpack
        self.assertIsNone(enginemod._select_quantized_engine())

    def test_empty_setting_leaves_torch_choice(self) -> None:
        self._settings(quantized_engine="")
        self.assertIsNone(enginemod._select_quantized_engine())

    def test_engine_is_only_selected_when_quantizing(self) -> None:
        enginemod.IS_AARCH64 = True
        self._settings(quantize=False, quantized_engine="auto")
        torch.backends.quantized.engine = "none"
        self.assertIsNone(enginemod._apply_cpu_tuning()["quantized_engine"])
        self.assertEqual(torch.backends.quantized.engine, "none")

        self._settings(quantize=True, quantized_engine="auto")
        self.assertEqual(enginemod._apply_cpu_tuning()["quantized_engine"],
                         "qnnpack")
        self.addCleanup(setattr, torch.backends.quantized, "engine", "none")


class _OnceFailingModel:
    """Raises the inference-tensor RuntimeError on its first generate, then
    succeeds — the exact shape the engine's fallback exists for."""

    sample_rate = 24000

    def __init__(self, fail_first: bool = True):
        self.calls: list[str] = []
        self._fail_first = fail_first
        self.ready = threading.Event()

    def get_state_for_audio_prompt(self, source, truncate=True):
        return {"src": source}

    def generate_audio(self, state, text, **kw):
        self.calls.append(torch._tuning.get("entered"))
        if self._fail_first and len(self.calls) == 1:
            raise RuntimeError("Inference tensors cannot be saved for backward")
        return _FakeAudio()


class _FakeAudio:
    def detach(self):
        return self

    def squeeze(self):
        return self

    def numel(self):
        return 24000


class GenerationContextTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_settings = enginemod.SETTINGS
        self._orig_wav = enginemod.audio_to_wav_bytes
        self._orig_tts = sys.modules["pocket_tts"].TTSModel
        self._orig_infer = enginemod._INFERENCE_MODE_OK
        enginemod.SETTINGS = dataclasses.replace(
            self._orig_settings, workers=1, queue_max=8, torch_threads=1)
        enginemod.audio_to_wav_bytes = lambda audio, sr: b"WAV"

    def tearDown(self) -> None:
        enginemod.SETTINGS = self._orig_settings
        enginemod.audio_to_wav_bytes = self._orig_wav
        sys.modules["pocket_tts"].TTSModel = self._orig_tts
        enginemod._INFERENCE_MODE_OK = self._orig_infer

    def _engine(self, model) -> TtsEngine:
        sys.modules["pocket_tts"].TTSModel = types.SimpleNamespace(
            load_model=lambda language, quantize: model)
        eng = TtsEngine()
        eng.start()
        self.addCleanup(eng.stop, 5.0)
        return eng

    def test_generation_runs_under_inference_mode_by_default(self) -> None:
        enginemod._INFERENCE_MODE_OK = True
        model = _OnceFailingModel(fail_first=False)
        eng = self._engine(model)
        eng.submit("hello", "alba").future.result(timeout=10)
        self.assertEqual(model.calls[-1], "inference_mode")

    def test_inference_mode_incompatibility_falls_back_and_retries(self) -> None:
        enginemod._INFERENCE_MODE_OK = True
        model = _OnceFailingModel(fail_first=True)
        eng = self._engine(model)
        # The request SUCCEEDS: the failed inference_mode attempt is retried on
        # the proven no_grad path rather than surfacing to the caller.
        res = eng.submit("hello", "alba").future.result(timeout=10)
        self.assertEqual(res.wav_bytes, b"WAV")
        self.assertEqual(model.calls, ["inference_mode", "no_grad"])
        # ...and the whole process stays demoted, so it happens once.
        self.assertFalse(enginemod._INFERENCE_MODE_OK)

    def test_unrelated_runtime_errors_still_surface(self) -> None:
        enginemod._INFERENCE_MODE_OK = True

        class _Boom(_OnceFailingModel):
            def generate_audio(self, state, text, **kw):
                raise RuntimeError("model weights are corrupt")

        eng = self._engine(_Boom(fail_first=False))
        with self.assertRaises(RuntimeError) as ctx:
            eng.submit("hello", "alba").future.result(timeout=10)
        self.assertIn("corrupt", str(ctx.exception))
        self.assertTrue(enginemod._INFERENCE_MODE_OK)  # not demoted by noise

    def test_disabled_by_env_uses_no_grad(self) -> None:
        enginemod._INFERENCE_MODE_OK = False  # TTS_INFERENCE_MODE=0
        model = _OnceFailingModel(fail_first=False)
        eng = self._engine(model)
        eng.submit("hello", "alba").future.result(timeout=10)
        self.assertEqual(model.calls[-1], "no_grad")

    def test_note_inference_failure_is_idempotent(self) -> None:
        enginemod._INFERENCE_MODE_OK = False
        self.assertFalse(enginemod._note_inference_failure(
            RuntimeError("Inference tensors ...")))


class FfmpegThreadCapTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = enginemod.SETTINGS
        self._orig_run = enginemod.subprocess.run

    def tearDown(self) -> None:
        enginemod.SETTINGS = self._orig
        enginemod.subprocess.run = self._orig_run

    def _capture(self, threads: int) -> list[str]:
        enginemod.SETTINGS = dataclasses.replace(self._orig,
                                                 ffmpeg_threads=threads)
        seen: dict = {}

        def fake_run(cmd, **kw):
            seen["cmd"] = cmd
            return types.SimpleNamespace(returncode=0, stdout=b"MP3", stderr=b"")

        enginemod.subprocess.run = fake_run
        enginemod.wav_bytes_to_mp3(b"RIFFfake", bitrate="128k")
        return seen["cmd"]

    def test_encoder_threads_are_capped_by_default(self) -> None:
        cmd = self._capture(1)
        self.assertEqual(cmd.count("-threads"), 2)  # decoder + encoder
        for i, tok in enumerate(cmd):
            if tok in ("-threads", "-filter_threads"):
                self.assertEqual(cmd[i + 1], "1")
        # The cap must precede the input so it binds the decoder too.
        self.assertLess(cmd.index("-threads"), cmd.index("-i"))

    def test_zero_reverts_to_ffmpegs_own_default(self) -> None:
        cmd = self._capture(0)
        self.assertNotIn("-threads", cmd)
        self.assertNotIn("-filter_threads", cmd)


if __name__ == "__main__":
    unittest.main()
