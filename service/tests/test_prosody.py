"""The probe that lets the studio hear its own voices.

Two contracts are under test here, and they are different in kind:

* ``prosody.probe`` must MEASURE — a 200 Hz tone has to come back as 200 Hz, a
  louder take as louder, a faster one as faster. Ordering assertions (this take
  is brighter than that one) matter more than absolute values, because ordering
  is all ``emotions.nearest_measured`` consumes.
* ``prosody.probe`` must never crash a clone. Every degraded input has a NAMED
  outcome (``silent``, ``too_short``, ``unvoiced``) in a well-formed result, and
  the only exception it may raise is ``ProbeError`` for a file that is not
  readable audio at all.

The backfill tool is tested for the half that works without the model stack: a
stable, resumable plan, and a NAMED skip on a box where the engine can't load —
which is every dev box (torch/pocket_tts are container-only).
"""
from __future__ import annotations

import contextlib
import io
import math
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from service import prosody
from service.tools import prosody_backfill

RATE = 24000


def _write(path: Path, samples: np.ndarray, rate: int = RATE,
           width: int = 2, channels: int = 1) -> Path:
    """Write float samples in [-1, 1] as a real WAV (parsed by `wave`, like the
    pipeline's own files — never a hand-rolled header)."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        clipped = np.clip(samples, -1.0, 1.0)
        if width == 1:
            w.writeframes((clipped * 127.0 + 128.0).astype("<u1").tobytes())
        elif width == 2:
            w.writeframes((clipped * 32767.0).astype("<i2").tobytes())
        else:
            w.writeframes((clipped * 2147483000.0).astype("<i4").tobytes())
    return path


def _tone(freq: float, seconds: float = 1.0, amp: float = 0.3,
          rate: int = RATE) -> np.ndarray:
    t = np.arange(int(rate * seconds), dtype=np.float64) / rate
    return amp * np.sin(2.0 * math.pi * freq * t)


def _voiced(freq: float = 150.0, seconds: float = 1.5, amp: float = 0.3,
            harmonics: int = 5, rate: int = RATE) -> np.ndarray:
    """A crude glottal pulse train: fundamental plus decaying harmonics. Closer
    to speech than a sine, and it exercises the autocorrelation peak picker the
    way a real voice does (a sine has no competing harmonic structure)."""
    t = np.arange(int(rate * seconds), dtype=np.float64) / rate
    out = np.zeros_like(t)
    for h in range(1, harmonics + 1):
        out += (1.0 / h) * np.sin(2.0 * math.pi * freq * h * t)
    return amp * out / np.max(np.abs(out))


def _modulate(signal: np.ndarray, hz: float, rate: int = RATE) -> np.ndarray:
    """Amplitude-modulate to fake a syllable rate."""
    t = np.arange(signal.size, dtype=np.float64) / rate
    return signal * (0.55 + 0.45 * np.sin(2.0 * math.pi * hz * t))


class ProbeShapeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_result_carries_exactly_the_contract_fields(self) -> None:
        out = prosody.probe(_write(self.dir / "a.wav", _voiced()))
        self.assertEqual(set(out), set(prosody.FIELDS) | {"version"},
                         "a fully measured probe adds no reason key")
        self.assertEqual(out["version"], prosody.VERSION)
        for field in prosody.FIELDS:
            self.assertIsInstance(out[field], float, field)

    def test_version_is_stamped_on_degraded_results_too(self) -> None:
        # A reader must be able to tell WHICH probe produced a row even when the
        # row is empty, or an old failure looks like a new one.
        out = prosody.probe(_write(self.dir / "s.wav", np.zeros(RATE)))
        self.assertEqual(out["version"], prosody.VERSION)
        self.assertEqual(out["reason"], "silent")

    def test_probe_is_deterministic(self) -> None:
        path = _write(self.dir / "d.wav", _modulate(_voiced(), 4.0))
        self.assertEqual(prosody.probe(path), prosody.probe(path),
                         "synthesis routes on these numbers; they may not wobble")

    def test_flat_loudnormed_level_is_still_measured(self) -> None:
        """The regression the two-ended threshold exists for.

        `clean.wav` is loudnorm'd and mostly voiced, so its per-frame level is
        nearly flat. A floor-only gate (floor + 8 dB, clamped up to -12 dBFS)
        gates such a file out entirely and reports a good take as unmeasurable.
        """
        out = prosody.probe(_write(self.dir / "flat.wav", _voiced(amp=0.2)))
        self.assertNotIn("reason", out)
        self.assertIsNotNone(out["f0_mean"])

    def test_level_constants_match_the_other_whole_file_gate(self) -> None:
        # The constants are copied from ingest.measure_levels (documented in
        # prosody.py). If ingest retunes them, this fails instead of the two
        # halves of the service silently disagreeing about "background".
        from service import ingest
        for name in ("_DB_FLOOR", "_FLOOR_PCT", "_SPEECH_PCT", "_NOISE_MARGIN_DB",
                     "_SPEECH_HEADROOM_DB", "_SILENT_DBFS", "_THRESHOLD_CLAMP"):
            with self.subTest(constant=name):
                self.assertEqual(getattr(prosody, name), getattr(ingest, name))


class ProbeMeasurementTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _probe(self, name: str, samples: np.ndarray, **kw) -> dict:
        return prosody.probe(_write(self.dir / name, samples, **kw))

    def test_pitch_of_a_known_tone(self) -> None:
        out = self._probe("t.wav", _tone(200.0))
        self.assertAlmostEqual(out["f0_mean"], 200.0, delta=3.0)
        self.assertLess(out["f0_sd"], 2.0, "a steady tone has no pitch spread")

    def test_pitch_of_a_harmonic_voice(self) -> None:
        out = self._probe("v.wav", _voiced(freq=180.0))
        self.assertAlmostEqual(out["f0_mean"], 180.0, delta=5.0)

    def test_pitch_ordering_survives_harmonics(self) -> None:
        low = self._probe("low.wav", _voiced(freq=110.0))
        high = self._probe("high.wav", _voiced(freq=240.0))
        self.assertLess(low["f0_mean"], high["f0_mean"])

    def test_expressive_pitch_has_a_bigger_spread_than_monotone(self) -> None:
        rate, seconds = RATE, 2.0
        t = np.arange(int(rate * seconds), dtype=np.float64) / rate
        # 4 Hz vibrato over +-40 Hz: same mean pitch, very different sd.
        phase = 2.0 * math.pi * (170.0 * t
                                 + (40.0 / (2.0 * math.pi * 4.0))
                                 * -np.cos(2.0 * math.pi * 4.0 * t))
        animated = self._probe("anim.wav", 0.3 * np.sin(phase))
        flat = self._probe("flat.wav", _tone(170.0, seconds))
        self.assertGreater(animated["f0_sd"], flat["f0_sd"] + 3.0)

    def test_louder_take_reports_more_energy(self) -> None:
        quiet = self._probe("q.wav", _voiced(amp=0.05))
        loud = self._probe("l.wav", _voiced(amp=0.6))
        self.assertLess(quiet["energy_rms"], loud["energy_rms"])

    def test_brighter_take_reports_higher_tilt(self) -> None:
        dark = self._probe("dark.wav", _tone(200.0))
        bright = self._probe("bright.wav", _tone(6000.0))
        self.assertGreater(bright["spectral_tilt"], dark["spectral_tilt"])

    def test_faster_amplitude_events_report_a_higher_rate(self) -> None:
        slow = self._probe("slow.wav", _modulate(_voiced(seconds=3.0), 1.5))
        fast = self._probe("fast.wav", _modulate(_voiced(seconds=3.0), 6.0))
        self.assertGreater(fast["rate_proxy"], slow["rate_proxy"])

    def test_stereo_is_mixed_down_not_misread(self) -> None:
        mono = _voiced(freq=200.0, seconds=1.5)
        stereo = np.repeat(mono, 2)  # interleaved L/R, identical channels
        out = prosody.probe(
            _write(self.dir / "st.wav", stereo, channels=2))
        self.assertAlmostEqual(out["f0_mean"], 200.0, delta=6.0)

    def test_eight_bit_unsigned_pcm_is_decoded(self) -> None:
        out = self._probe("u8.wav", _voiced(freq=200.0), width=1)
        self.assertAlmostEqual(out["f0_mean"], 200.0, delta=8.0)

    def test_low_sample_rate_still_measures(self) -> None:
        out = prosody.probe(
            _write(self.dir / "8k.wav", _voiced(freq=150.0, rate=8000), rate=8000))
        self.assertAlmostEqual(out["f0_mean"], 150.0, delta=8.0)


class ProbeHonestyTests(unittest.TestCase):
    """Degraded audio: a named outcome in a well-formed dict, never a crash."""

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_digital_silence_is_named_not_zeroed(self) -> None:
        out = prosody.probe(_write(self.dir / "z.wav", np.zeros(RATE)))
        self.assertEqual(out["reason"], "silent")
        for field in prosody.FIELDS:
            self.assertIsNone(out[field],
                              f"{field}: silence is UNMEASURED, not zero")

    def test_near_silence_is_silence(self) -> None:
        # -80 dBFS of dither: readable, but its loudest moment is silence.
        faint = 1e-4 * np.sin(np.arange(RATE, dtype=np.float64) * 0.01)
        self.assertEqual(prosody.probe(
            _write(self.dir / "f.wav", faint))["reason"], "silent")

    def test_too_short_is_named(self) -> None:
        out = prosody.probe(_write(self.dir / "sh.wav", _voiced(seconds=0.1)))
        self.assertEqual(out["reason"], "too_short")
        self.assertIsNone(out["energy_rms"])

    def test_empty_file_is_named(self) -> None:
        out = prosody.probe(_write(self.dir / "e.wav", np.zeros(0)))
        self.assertEqual(out["reason"], "empty")

    def test_unvoiced_audio_keeps_the_features_it_does_have(self) -> None:
        # Broadband noise: no recoverable period, but energy and tilt are real.
        rng = np.random.default_rng(7)
        out = prosody.probe(
            _write(self.dir / "n.wav", 0.3 * rng.standard_normal(RATE * 2)))
        self.assertEqual(out["reason"], "unvoiced")
        self.assertIsNone(out["f0_mean"])
        self.assertIsNone(out["f0_sd"])
        self.assertIsNotNone(out["energy_rms"])
        self.assertIsNotNone(out["spectral_tilt"])

    def test_missing_file_raises_probe_error_only(self) -> None:
        with self.assertRaises(prosody.ProbeError):
            prosody.probe(self.dir / "nope.wav")

    def test_non_audio_bytes_raise_probe_error(self) -> None:
        path = self.dir / "junk.wav"
        path.write_bytes(b"this is not a RIFF file at all")
        with self.assertRaises(prosody.ProbeError):
            prosody.probe(path)

    def test_unsupported_sample_width_is_named(self) -> None:
        path = self.dir / "w24.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(3)  # 24-bit: legal WAV, not a width numpy can view
            w.setframerate(RATE)
            w.writeframes(b"\x00\x01\x02" * RATE)
        with self.assertRaises(prosody.ProbeError) as ctx:
            prosody.probe(path)
        self.assertIn("24-bit", str(ctx.exception))

    def test_probe_error_is_a_value_error(self) -> None:
        # The C2 hook catches broad Exception, but callers that narrow should
        # still be able to; ProbeError must not be its own unrelated hierarchy.
        self.assertTrue(issubclass(prosody.ProbeError, ValueError))


class BackfillPlanTests(unittest.TestCase):
    """The half of the tool that needs no model: which rows to measure."""

    def test_rows_without_prosody_are_targets(self) -> None:
        meta = {"voices": {"b": {"emotion": "baseline"},
                           "a": {"emotion": "happy", "prosody": {
                               "version": prosody.VERSION, "f0_mean": 180.0}}}}
        self.assertEqual(prosody_backfill.plan(meta), ["b"])

    def test_stale_version_and_reason_only_rows_are_targets(self) -> None:
        stale = {"version": prosody.VERSION - 1, "f0_mean": 180.0}
        empty = {"version": prosody.VERSION, "reason": "silent",
                 **{f: None for f in prosody.FIELDS}}
        meta = {"voices": {"stale": {"prosody": stale},
                           "silent": {"prosody": empty}}}
        self.assertEqual(prosody_backfill.plan(meta), ["silent", "stale"])

    def test_plan_order_is_stable_so_limit_is_resumable(self) -> None:
        meta = {"voices": {v: {} for v in ("zed", "abe", "mid")}}
        self.assertEqual(prosody_backfill.plan(meta), ["abe", "mid", "zed"])
        self.assertEqual(prosody_backfill.plan(meta, limit=2), ["abe", "mid"])
        self.assertEqual(prosody_backfill.plan(meta, limit=0), [])

    def test_partial_probe_counts_as_measured(self) -> None:
        # An `unvoiced` whisper has energy and tilt: real data, do not redo it.
        row = {"prosody": {"version": prosody.VERSION, "reason": "unvoiced",
                           "f0_mean": None, "energy_rms": 0.1}}
        self.assertFalse(prosody_backfill.needs_probe(row))

    def test_garbage_rows_are_not_targets(self) -> None:
        self.assertFalse(prosody_backfill.needs_probe("not a row"))
        self.assertEqual(prosody_backfill.plan({}), [])


class BackfillDegradeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _run(self, **kw) -> tuple[int, str]:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = prosody_backfill.run(self.dir, limit=None, dry_run=False, **kw)
        return code, buf.getvalue()

    def _registry(self, text: str) -> None:
        (self.dir / "_meta.json").write_text(text, encoding="utf-8")

    def test_missing_registry_is_an_empty_plan(self) -> None:
        code, out = self._run()
        self.assertEqual(code, 0)
        self.assertIn("0 voice(s) need measuring", out)

    def test_unreadable_registry_is_named_not_fatal(self) -> None:
        self._registry("{ this is not json")
        code, out = self._run()
        self.assertEqual(code, 0)
        self.assertIn("skipped: registry unreadable", out)

    def test_engine_unavailable_is_a_named_skip_per_voice(self) -> None:
        # The whole point: on a dev box (no torch/pocket_tts) the operator is
        # told WHY nothing was written, and the exit code stays 0.
        self._registry('{"voices": {"alba": {"emotion": "baseline"}}}')

        def _no_engine():
            return None, "engine unavailable (ModuleNotFoundError: torch)"

        real = prosody_backfill.open_engine
        prosody_backfill.open_engine = _no_engine
        self.addCleanup(setattr, prosody_backfill, "open_engine", real)
        code, out = self._run()
        self.assertEqual(code, 0)
        self.assertIn("alba: skipped: engine unavailable", out)
        self.assertIn("0 of 1 measured", out)

    def test_dry_run_never_touches_the_engine(self) -> None:
        self._registry('{"voices": {"alba": {}, "vera": {}}}')

        def _boom():
            raise AssertionError("dry-run must not open the engine")

        real = prosody_backfill.open_engine
        prosody_backfill.open_engine = _boom
        self.addCleanup(setattr, prosody_backfill, "open_engine", real)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = prosody_backfill.run(self.dir, limit=None, dry_run=True)
        self.assertEqual(code, 0)
        self.assertIn("alba: would measure", buf.getvalue())

    def test_store_is_a_no_op_when_nothing_was_measured(self) -> None:
        # Guards the write path from opening the registry for zero rows.
        self.assertEqual(prosody_backfill.store({}), 0)

    def test_calibration_text_is_long_enough_to_probe(self) -> None:
        # The sentence must synthesize past prosody's minimum duration; a short
        # prompt would make every backfilled row read `too_short`.
        self.assertGreater(len(prosody_backfill.CALIBRATION_TEXT), 60)


class ProbeFeedsEmotionsTests(unittest.TestCase):
    """End to end at the seam that matters: real probes -> measured fallback."""

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_real_probes_route_a_miss_to_the_acoustic_neighbour(self) -> None:
        from service import emotions as em

        # One speaker, three takes: a loud fast bright one, a quiet slow one,
        # and a middling one. Nothing declares an emotion acoustically here —
        # the audio does.
        probes = {
            "baseline": prosody.probe(_write(
                self.dir / "b.wav", _modulate(_voiced(freq=150.0, amp=0.25,
                                                      seconds=3.0), 3.0))),
            "sad": prosody.probe(_write(
                self.dir / "s.wav", _modulate(_voiced(freq=110.0, amp=0.05,
                                                      seconds=3.0), 1.2))),
            "angry": prosody.probe(_write(
                self.dir / "a.wav", _modulate(_voiced(freq=230.0, amp=0.7,
                                                      seconds=3.0, harmonics=9),
                                              6.0))),
        }
        for slot, out in probes.items():
            self.assertNotIn("reason", out, f"{slot} should be fully measured")

        available = {e: f"{e}-id" for e in probes}
        # `excited` is missing. The prior puts it high on every axis, so the
        # measured walk must land on the loud/fast/bright take, NOT on the
        # hardcoded chain's answer (excited -> happy, which doesn't exist here,
        # then baseline).
        vid, used, fell = em.resolve("excited", available, prosody=probes)
        self.assertEqual((vid, used, fell), ("angry-id", "angry", True))
        # Without the measurements the same request takes the old chain path.
        self.assertEqual(em.resolve("excited", available)[1], "baseline")

    def test_label_check_flags_a_mislabelled_take(self) -> None:
        from service import emotions as em

        loud = prosody.probe(_write(
            self.dir / "loud.wav", _modulate(_voiced(freq=240.0, amp=0.7,
                                                     seconds=3.0, harmonics=9), 6.0)))
        quiet = prosody.probe(_write(
            self.dir / "quiet.wav", _modulate(_voiced(freq=110.0, amp=0.05,
                                                      seconds=3.0), 1.2)))
        rows = [{"emotion": "whisper", "prosody": quiet}]
        # A shouted take declared `whisper` must not silently agree.
        out = em.label_check(loud, "whisper", rows)
        self.assertIsNotNone(out)
        self.assertFalse(out["agrees"])
        self.assertNotEqual(out["nearest"], "whisper")
        self.assertIsInstance(out["distance"], float)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
