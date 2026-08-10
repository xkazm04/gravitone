"""Real recorded humans, for the tests that may not use synthetic speech.

Two of this repo's measurements are worthless against TTS audio and this module
exists so they can be run against people instead:

* ``diarize.py``'s own table says so out loud — two clips of one synthetic voice
  can land further apart than clips of two different humans, so a diarization
  number swept over TTS fixtures would be a WORSE number wearing the authority
  of a measurement.
* ``ingest.measure_segments`` inherits the same embedder, so the constants that
  decide whether a segment is thrown out of a clone (``FOREIGN_SIMILARITY``,
  ``OUTLIER_MAD_K``) have the same problem.

The fixtures are sherpa-onnx's own labelled diarization samples — real recorded
conversations, published from a plain GitHub release with no account and no
terms, the same place ``diarize.download()`` fetches the models from. They live
beside the models (``diarization_models/``, which is gitignored) and are fetched
on demand: every caller of this module is an opt-in test that already needed a
34 MB model download, so one more fetch is not a new cost — and each helper
returns None rather than raising when the network or the file is not there, so
a test skips instead of failing on somebody's laptop.

Nothing here is imported by the service. It is test scaffolding only.
"""
from __future__ import annotations

import shutil
import urllib.request
import wave
from pathlib import Path

import numpy as np

from service import diarize

RATE = diarize.TARGET_RATE

_RELEASE = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/"
            "speaker-segmentation-models/")

# name -> how many people are really in it (the fixtures' own published labels).
FIXTURES: dict[str, int] = {
    "1-two-speakers-en.wav": 2,
    "0-four-speakers-zh.wav": 4,
}


def fixture(name: str, *, download: bool = True) -> Path | None:
    """The fixture on disk, fetching it once if allowed. None if unavailable.

    None — never an exception — because the only callers are tests whose honest
    response to "no fixture" is to skip: asserting a speaker count against audio
    that is not there would be worse than not asserting it.
    """
    path = diarize.models_dir() / name
    if path.is_file():
        return path
    if not download:
        return None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".part")
        with urllib.request.urlopen(_RELEASE + name, timeout=120) as r, \
                open(partial, "wb") as out:
            shutil.copyfileobj(r, out)
        partial.replace(path)          # atomic: a killed fetch is never a fixture
        return path
    except Exception:                  # noqa: BLE001 - offline is a skip, not a failure
        return None


def read_mono16k(path: Path) -> np.ndarray:
    """A wav as float32 mono in [-1, 1] at 16 kHz — what ``diarize`` wants."""
    with wave.open(str(path), "rb") as w:
        width, channels, rate = w.getsampwidth(), w.getnchannels(), w.getframerate()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError(f"{path.name} is {width * 8}-bit; these fixtures are PCM16")
    data = np.frombuffer(raw, "<i2").astype(np.float32) / 32768.0
    if channels > 1:
        data = data[:(data.size // channels) * channels].reshape(-1, channels).mean(1)
    if rate != RATE:
        n = max(1, int(round(data.size * RATE / rate)))
        data = np.interp(np.linspace(0.0, data.size - 1, n),
                         np.arange(data.size), data).astype(np.float32)
    return np.ascontiguousarray(data, dtype=np.float32)


def write_mono16k(path: Path, samples: np.ndarray) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes())
    return path


def rms(samples: np.ndarray) -> float:
    """RMS, never zero — these are all denominators of an SNR."""
    return max(float(np.sqrt(np.mean(np.square(samples)))), 1e-9)


def at_snr(speech: np.ndarray, bed: np.ndarray, snr_db: float) -> np.ndarray:
    """``speech`` with ``bed`` mixed under it at exactly ``snr_db``."""
    n = min(speech.size, bed.size)
    scaled = bed[:n] / rms(bed[:n]) * rms(speech[:n]) * (10.0 ** (-snr_db / 20.0))
    return (speech[:n] + scaled).astype(np.float32)


def noise_bed(n: int, seed: int = 11) -> np.ndarray:
    """Broadband hiss — a cheap microphone, a fan, a bad preamp."""
    return np.random.default_rng(seed).normal(0.0, 1.0, n).astype(np.float32)


def music_bed(n: int) -> np.ndarray:
    """A tonal bed: an A minor triad plus an octave, with a slow tremolo.

    Deliberately harmonic rather than broadband — a music bed and a noise bed
    are different inputs and, as the diarize table records, this model treats
    them very differently.
    """
    t = np.arange(n, dtype=np.float64) / RATE
    tone = sum(np.sin(2.0 * np.pi * f * t) for f in (110.0, 164.8, 220.0, 329.6))
    return (tone * (0.6 + 0.4 * np.sin(2.0 * np.pi * 0.5 * t))).astype(np.float32)


def segment_wavs(audio: np.ndarray, result, out_dir: Path, tag: str,
                 *, min_dur: float = 1.2, max_dur: float = 15.0) -> dict[str, list[Path]]:
    """Cut a diarization into per-speaker segment wavs, the way ingest cuts.

    Same chunking rule as ``ingest._chunk_spans`` with ``label_and_stem``'s
    defaults, so the clips measured here are the clips the clone pipeline would
    actually embed — not an idealized version of them.
    """
    out: dict[str, list[Path]] = {}
    out_dir.mkdir(parents=True, exist_ok=True)
    for turn in result.turns:
        cur = turn.start
        while turn.end - cur >= min_dur:
            end = min(cur + max_dur, turn.end)
            rows = out.setdefault(turn.speaker, [])
            rows.append(write_mono16k(
                out_dir / f"{tag}_{turn.speaker}_{len(rows):03d}.wav",
                audio[int(cur * RATE):int(end * RATE)]))
            cur = end
    return out
