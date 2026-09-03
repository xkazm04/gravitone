"""Ingest audio path — segment extraction and stem assembly.

This is the audio that every cloned voice is built from, and it was untested.

Part 1 — `to_wav` seeks on the INPUT (`-ss` before `-i`) so an extract no longer decodes
the whole recording from byte zero. Input seeking can land on the nearest seek
point, which would silently shift a labelled span and corrupt every clone made
from it — so these tests PROVE the boundaries rather than assuming them.

Method: build a source whose every second is a different pure tone, extract a
span, and identify each second of the result by counting zero crossings
(a pure sine at f Hz crosses zero 2f times per second). Run on both a wav source
(what the pipeline actually feeds `to_wav`) and an mp3 source (the compressed
case, where seek points are coarse and a fast seek would visibly shift).

Part 2 — stem assembly: WHAT goes into the neutral stem (baseline-labelled audio
only, with a stated fallback), HOW segments are spliced (level-matched, faded,
gapped — no clicks in the reference audio), the cap semantics, and that reported
eligibility is computed from the same measurement `commit` will re-take.

Part 1 requires ffmpeg (skipped without it); part 2 synthesises its own wavs.
"""
from __future__ import annotations

import array
import json
import math
import shutil
import subprocess
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import ingest
from service.emotions import BASELINE

HAVE_FFMPEG = shutil.which("ffmpeg") is not None

# One tone per second of the source: second i is TONES[i] Hz.
TONES = [200, 400, 600, 800, 1000, 1200, 1400, 1600]


def _build_source(dst: Path) -> None:
    """A `len(TONES)`-second file, one distinct pure tone per second."""
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    for f in TONES:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency={f}:duration=1:sample_rate=24000"]
    cmd += ["-filter_complex", f"concat=n={len(TONES)}:v=0:a=1", "-ac", "1", str(dst)]
    r = subprocess.run(cmd, capture_output=True)
    assert r.returncode == 0, r.stderr.decode(errors="ignore")[-400:]


def _read(path: Path) -> tuple[array.array, int]:
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2
        rate = w.getframerate()
        samples = array.array("h")
        samples.frombytes(w.readframes(w.getnframes()))
    return samples, rate


def _freq(win, rate: int) -> float:
    """Frequency of a pure tone, by zero crossings (2 per cycle)."""
    crossings = sum(1 for i in range(1, len(win))
                    if (win[i - 1] < 0) != (win[i] < 0))
    return crossings / 2 / (len(win) / rate)


def _tone_of(samples: array.array, rate: int, sec: float) -> float:
    """Dominant frequency of the 0.8 s window starting at `sec`. The window is
    inset from the second's edges so a few ms of codec delay or fade cannot
    bleed a neighbouring tone into the measurement."""
    a, b = int((sec + 0.1) * rate), min(int((sec + 0.9) * rate), len(samples))
    win = samples[a:b]
    assert len(win) > rate // 10, f"window at {sec}s is short ({len(win)} samples)"
    return _freq(win, rate)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not available")
class ExtractBoundaryTests(unittest.TestCase):
    """The cut audio must match the labelled span, on every accepted format."""

    def _assert_span(self, src: Path, dst: Path, start: float, end: float,
                     expect: list[int]) -> None:
        ingest.to_wav(src, dst, start, end)
        samples, rate = _read(dst)
        self.assertEqual(rate, 24000)                       # unchanged output rate
        self.assertAlmostEqual(len(samples) / rate, end - start, delta=0.06)
        for i, want in enumerate(expect):
            got = _tone_of(samples, rate, float(i))
            self.assertAlmostEqual(
                got, want, delta=want * 0.05,
                msg=f"second {i} of [{start},{end}] reads {got:.0f}Hz, want {want}Hz "
                    f"— the extract is shifted, not aligned to the labelled span")

    def test_wav_source_boundaries(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            src = wd / "src.wav"
            _build_source(src)
            # mid-file span, a span that starts inside the preroll, and t=0
            self._assert_span(src, wd / "a.wav", 3.0, 6.0, TONES[3:6])
            self._assert_span(src, wd / "b.wav", 0.0, 2.0, TONES[0:2])
            self._assert_span(src, wd / "c.wav", 3.5, 4.0, [TONES[3]])  # sub-second start
            self._assert_span(src, wd / "d.wav", 6.0, 8.0, TONES[6:8])

    def test_mp3_source_boundaries(self) -> None:
        """Compressed source: a fast (single-stage) seek is free to land on a
        frame boundary well before `start`; the two-stage cut must not."""
        with TemporaryDirectory() as td:
            wd = Path(td)
            wav, mp3 = wd / "src.wav", wd / "src.mp3"
            _build_source(wav)
            r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
                                "-c:a", "libmp3lame", "-b:a", "128k", str(mp3)],
                               capture_output=True)
            if r.returncode != 0:
                self.skipTest("no mp3 encoder")
            self._assert_span(mp3, wd / "a.wav", 3.0, 6.0, TONES[3:6])
            self._assert_span(mp3, wd / "b.wav", 5.0, 7.0, TONES[5:7])

    def test_open_ended_and_head_spans(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            src = wd / "src.wav"
            _build_source(src)
            ingest.to_wav(src, wd / "tail.wav", 6.0, None)      # start only → EOF
            s, rate = _read(wd / "tail.wav")
            self.assertAlmostEqual(len(s) / rate, 2.0, delta=0.06)
            self.assertAlmostEqual(_tone_of(s, rate, 0.0), TONES[6], delta=TONES[6] * 0.05)

            ingest.to_wav(src, wd / "head.wav", None, 2.0)      # end only → from 0
            s, rate = _read(wd / "head.wav")
            self.assertAlmostEqual(len(s) / rate, 2.0, delta=0.06)
            self.assertAlmostEqual(_tone_of(s, rate, 0.0), TONES[0], delta=TONES[0] * 0.05)

    def test_seeks_on_the_input_side(self) -> None:
        """Guard the optimization itself: `-ss` must precede `-i`, or every
        extract silently goes back to decoding the file from byte zero."""
        seen: list[list[str]] = []

        class _R:
            returncode = 0
            stderr = b""

        orig = ingest.subprocess.run
        try:
            ingest.subprocess.run = lambda cmd, **kw: (seen.append(cmd), _R())[1]  # type: ignore[assignment]
            ingest.to_wav(Path("in.mp3"), Path("out.wav"), 540.0, 544.0)
        finally:
            ingest.subprocess.run = orig  # type: ignore[assignment]
        cmd = seen[0]
        i = cmd.index("-i")
        self.assertIn("-ss", cmd[:i], "no input-side seek — full decode per extract")
        self.assertEqual(cmd[i - 1], f"{540.0 - ingest._SEEK_PREROLL:.3f}")
        self.assertIn("-ss", cmd[i:], "no fine seek — boundary is only keyframe-accurate")
        self.assertIn("-t", cmd)
        self.assertNotIn("-to", cmd)

    def test_empty_span_is_rejected(self) -> None:
        with self.assertRaises(RuntimeError):
            ingest.to_wav(Path("x.wav"), Path("y.wav"), 5.0, 5.0)


RATE = 24000


def _write_tone(path: Path, freq: float, seconds: float, amp: float = 0.5) -> None:
    """A pure tone wav in the pipeline's own format (24 kHz mono 16-bit).
    Identity travels as FREQUENCY so level matching (which normalises amplitude)
    cannot erase which segment a piece of a stem came from."""
    n = int(seconds * RATE)
    data = array.array("h", (int(amp * 32767 * math.sin(2 * math.pi * freq * i / RATE))
                             for i in range(n)))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data.tobytes())


def _pieces(path: Path) -> list[array.array]:
    """Split a stem back into its segments at the silent gaps — which also
    proves the gaps are there."""
    samples, rate = _read(path)
    out: list[array.array] = []
    cur = array.array("h")
    run = 0
    quiet = 60                      # ≈ -55 dBFS: silence, not a fade tail
    min_gap = int(0.04 * rate)
    for s in samples:
        if abs(s) < quiet:
            run += 1
            cur.append(s)
        else:
            if run >= min_gap and len(cur) > run:
                out.append(cur[:-run])
                cur = array.array("h")
            run = 0
            cur.append(s)
    if len(cur) - run > 0:
        out.append(cur[:len(cur) - run] if run else cur)
    return [p for p in out if len(p) > rate // 20]


class ConcatCapTests(unittest.TestCase):
    """The reported duration must equal the written file, always."""

    def test_empty_input_is_rejected(self) -> None:
        with TemporaryDirectory() as td:
            with self.assertRaises(RuntimeError):
                ingest.concat_wavs([], Path(td) / "out.wav")

    def test_reported_seconds_match_the_file(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            paths = []
            for i in range(3):
                p = wd / f"s{i}.wav"
                _write_tone(p, 300 + 100 * i, 2.0)
                paths.append(p)
            res = ingest.concat_wavs(paths, wd / "stem.wav")
            with wave.open(str(wd / "stem.wav"), "rb") as w:
                on_disk = round(w.getnframes() / w.getframerate(), 2)
            self.assertEqual(res.seconds, on_disk)
            self.assertEqual(res.segments, 3)
            # 3 × 2s + 2 silent gaps
            self.assertAlmostEqual(res.seconds, 6.0 + 2 * ingest._GAP_SECONDS, places=2)

    def test_cap_is_a_hard_ceiling_at_whole_segments(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            paths = []
            for i in range(4):
                p = wd / f"s{i}.wav"
                _write_tone(p, 300 + 100 * i, 12.0)
                paths.append(p)
            res = ingest.concat_wavs(paths, wd / "stem.wav", cap_seconds=30.0)
            with wave.open(str(wd / "stem.wav"), "rb") as w:
                on_disk = w.getnframes() / w.getframerate()
            self.assertLessEqual(on_disk, 30.0)       # the OLD code wrote 36s here
            self.assertEqual(res.segments, 2)         # third would overflow → dropped
            self.assertEqual(res.seconds, round(on_disk, 2))

    def test_lone_oversize_segment_is_truncated_not_dropped(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            p = wd / "s.wav"
            _write_tone(p, 400, 40.0)
            res = ingest.concat_wavs([p], wd / "stem.wav", cap_seconds=30.0)
            self.assertEqual(res.segments, 1)
            self.assertEqual(res.seconds, 30.0)
            with wave.open(str(wd / "stem.wav"), "rb") as w:
                self.assertEqual(round(w.getnframes() / w.getframerate(), 2), 30.0)


class SpliceQualityTests(unittest.TestCase):
    """No clicks and no level pumping in the audio the embedding learns from."""

    def _stem(self, wd: Path, amps: list[float]) -> Path:
        paths = []
        for i, a in enumerate(amps):
            p = wd / f"s{i}.wav"
            _write_tone(p, 400.0, 2.0, amp=a)
            paths.append(p)
        ingest.concat_wavs(paths, wd / "stem.wav")
        return wd / "stem.wav"

    def test_levels_are_matched_without_clipping(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            stem = self._stem(wd, [0.28, 0.5, 0.45])   # ~5 dB spread going in
            parts = _pieces(stem)
            self.assertEqual(len(parts), 3)
            rms = [math.sqrt(sum(float(s) ** 2 for s in p) / len(p)) for p in parts]
            spread_db = 20 * math.log10(max(rms) / min(rms))
            self.assertLess(spread_db, 1.5, f"levels still {spread_db:.1f} dB apart")
            peak = max(abs(s) for p in parts for s in p)
            self.assertLessEqual(peak, int(ingest._PEAK_CEILING * 32767) + 1)

    def test_gain_is_clamped_so_a_silent_segment_cannot_pump(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            stem = self._stem(wd, [0.5, 0.5, 0.001])   # one near-silent outlier
            parts = _pieces(stem)
            quiet = min(parts, key=lambda p: max(abs(s) for s in p))
            gain = max(abs(s) for s in quiet) / (0.001 * 32767)
            self.assertLessEqual(gain, ingest._GAIN_RANGE[1] * 1.05,
                                 "near-silent segment was boosted past the clamp")

    def test_splice_boundaries_are_faded_to_zero(self) -> None:
        """A hard splice steps the waveform — that click gets learned."""
        with TemporaryDirectory() as td:
            wd = Path(td)
            paths = []
            for i in range(3):
                p = wd / f"s{i}.wav"
                # start each tone at a different phase-hostile frequency so a raw
                # concatenation WOULD step hard at the joins
                _write_tone(p, 317.0 + 211 * i, 1.0)
                paths.append(p)
            ingest.concat_wavs(paths, wd / "stem.wav")
            samples, rate = _read(wd / "stem.wav")
            step = max(abs(samples[i] - samples[i - 1]) for i in range(1, len(samples)))
            # the largest legitimate sample-to-sample step of the loudest tone
            legit = 2 * math.pi * 739 / rate * ingest._PEAK_CEILING * 32767
            self.assertLess(step, legit * 1.5, "waveform discontinuity at a splice")
            for p in _pieces(wd / "stem.wav"):
                self.assertLess(abs(p[0]), 500)    # faded in
                self.assertLess(abs(p[-1]), 500)   # faded out


def _seg_at(i: int, dur: float = 2.0) -> dict:
    return {"speaker": "speaker_0", "start": i * dur, "end": (i + 1) * dur, "text": f"t{i}"}


class StemAssemblyTests(unittest.TestCase):
    """WHAT lands in the neutral stem, and whether the UI can trust `eligible`."""

    #: segment index → (emotion, tone Hz). Frequency identifies the segment
    #: inside the finished stem.
    def _run(self, td: str, layout: list[str], dur: float = 2.0, min_stem: float = 4.0):
        wd = Path(td)
        n = len(layout)
        with wave.open(str(wd / "clean.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(b"\x00\x00" * RATE)
        (wd / "segments.json").write_text(
            json.dumps([_seg_at(i, dur) for i in range(n)]), "utf-8")

        def fake_to_wav(src, dst, a=None, b=None):
            i = int(Path(dst).stem.split("_")[1])
            _write_tone(Path(dst), 300.0 + 100 * i, dur)

        def fake_label(wav_paths, spend=None):
            # Labelling is BATCHED: one call carries several clips and returns
            # one result per clip, in order.
            out = []
            for p in wav_paths:
                i = int(Path(p).stem.split("_")[1])
                out.append({"emotion": layout[i], "confidence": 0.9,
                            "cue": f"c{i}", "model": "flash"})
            return out

        with mock.patch.object(ingest, "to_wav", side_effect=fake_to_wav), \
             mock.patch.object(ingest, "label_emotions", side_effect=fake_label):
            res = ingest.label_and_stem(wd, "speaker_0", min_stem=min_stem, mode="cloud")
        return wd, res, {s["emotion"]: s for s in res["stems"]}

    def _tones_in(self, path: Path) -> list[int]:
        return [round(_freq(p, RATE) / 100) * 100 for p in _pieces(path)]

    def test_baseline_holds_only_neutral_audio(self) -> None:
        layout = [BASELINE, BASELINE, BASELINE, "angry", "sad", "excited"]
        with TemporaryDirectory() as td:
            wd, res, by = self._run(td, layout)
            base = by[BASELINE]
            self.assertIsNone(base["note"])              # genuinely all-neutral
            self.assertEqual(base["segments"], 3)
            self.assertTrue(base["eligible"])
            # tones 300/400/500 are the baseline segments; 600/700/800 are the
            # angry/sad/excited takes and must NOT be in the neutral reference.
            self.assertEqual(self._tones_in(wd / "stem_baseline.wav"), [300, 400, 500])

    def test_emotion_stems_group_and_stay_in_recording_order(self) -> None:
        layout = [BASELINE, "angry", BASELINE, "angry", BASELINE, "angry"]
        with TemporaryDirectory() as td:
            wd, res, by = self._run(td, layout)
            self.assertEqual(by["angry"]["segments"], 3)
            self.assertEqual(self._tones_in(wd / "stem_angry.wav"), [400, 600, 800])
            self.assertEqual(self._tones_in(wd / "stem_baseline.wav"), [300, 500, 700])
            # display order follows the emotion scale, baseline first
            self.assertEqual(res["stems"][0]["emotion"], BASELINE)

    def test_thin_neutral_borrows_nearest_and_says_so(self) -> None:
        layout = [BASELINE, "angry", "calm", "happy"]     # only 2s neutral, need 4s
        with TemporaryDirectory() as td:
            wd, res, by = self._run(td, layout)
            base = by[BASELINE]
            self.assertTrue(base["eligible"])
            self.assertIsNotNone(base["note"])
            self.assertIn("calm", base["note"])           # nearest-neutral first
            self.assertNotIn("angry", base["note"])       # and ONLY what was needed
            self.assertEqual(self._tones_in(wd / "stem_baseline.wav"), [300, 500])

    def test_no_neutral_at_all_is_reported_not_hidden(self) -> None:
        layout = ["angry", "whisper", "happy"]
        with TemporaryDirectory() as td:
            wd, res, by = self._run(td, layout)
            note = by[BASELINE]["note"]
            self.assertIsNotNone(note)
            self.assertIn("0.0s of neutral speech", note)
            self.assertIn("happy", note)                  # happy borrowed before…
            self.assertNotIn("whisper", note)             # …whisper (no phonation)

    def test_eligible_matches_what_commit_will_measure(self) -> None:
        """The UI must not promise a stem that commit then silently skips."""
        layout = [BASELINE, BASELINE, "angry", "sad", "sad"]
        with TemporaryDirectory() as td:
            wd, res, by = self._run(td, layout, dur=1.7)
            for st in res["stems"]:
                sw = wd / f"stem_{st['emotion']}.wav"
                with wave.open(str(sw), "rb") as w:      # exactly commit()'s measurement
                    seconds = round(w.getnframes() / w.getframerate(), 2)
                self.assertEqual(st["seconds"], seconds)
                self.assertEqual(st["eligible"], seconds >= res["min_stem"])


if __name__ == "__main__":
    unittest.main()
