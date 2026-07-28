"""Ingest audio path — segment extraction boundaries.

`to_wav` seeks on the INPUT (`-ss` before `-i`) so an extract no longer decodes
the whole recording from byte zero. Input seeking can land on the nearest seek
point, which would silently shift a labelled span and corrupt every clone made
from it — so these tests PROVE the boundaries rather than assuming them.

Method: build a source whose every second is a different pure tone, extract a
span, and identify each second of the result by counting zero crossings
(a pure sine at f Hz crosses zero 2f times per second). Run on both a wav source
(what the pipeline actually feeds `to_wav`) and an mp3 source (the compressed
case, where seek points are coarse and a fast seek would visibly shift).

Requires ffmpeg; skipped when it is not on PATH.
"""
from __future__ import annotations

import array
import shutil
import subprocess
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory

from service import ingest

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


def _tone_of(samples: array.array, rate: int, sec: float) -> float:
    """Dominant frequency of the 0.8 s window starting at `sec` (zero crossings).
    The window is inset from the second's edges so a few ms of codec delay or
    fade cannot bleed a neighbouring tone into the measurement."""
    a, b = int((sec + 0.1) * rate), min(int((sec + 0.9) * rate), len(samples))
    win = samples[a:b]
    assert len(win) > rate // 10, f"window at {sec}s is short ({len(win)} samples)"
    crossings = sum(1 for i in range(1, len(win))
                    if (win[i - 1] < 0) != (win[i] < 0))
    return crossings / 2 / (len(win) / rate)


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


if __name__ == "__main__":
    unittest.main()
