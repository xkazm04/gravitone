"""What a recording actually sounds like — pitch, loudness, pace, colour.

The emotion label on a slot is, today, whatever the uploader typed. Nothing in
the system has ever *listened* to a take (see ``emotions.FALLBACK_CHAIN``: seven
human guesses about acoustic adjacency, identical for every speaker, empty for
every custom emotion). This module is the ear: five numbers over the already
loudnorm'd ``clean.wav`` the clone path has in hand and is about to throw away.

Deliberately cheap and deliberately sovereign — ``wave`` + numpy, no torch, no
model download, no second inference competing with the TTS pool for the cores
the launcher pinned. That is the same trade ``vad.py`` makes and for the same
reason; the constants below (``_NOISE_MARGIN_DB``, ``_THRESHOLD_CLAMP``,
``_DB_FLOOR``) are deliberately the values that module derives its gate from, so
two parts of the service cannot disagree about what "background" means.

The five features, and what each is honestly a proxy for:

* ``f0_mean`` / ``f0_sd`` (Hz) — median-ish pitch and its spread over voiced
  frames. Spread is the expressiveness signal: a monotone read and an animated
  one can share a mean and never share an sd.
* ``energy_rms`` (0..1 linear, speech frames only) — loudness. Measured over
  frames that beat the derived threshold, so trailing silence cannot make a
  shouted take read quiet.
* ``rate_proxy`` (peaks/second) — syllable rate approximated by counting maxima
  in the smoothed energy envelope. A proxy, named as one: it counts *amplitude*
  events, so a breathy speaker over-counts.
* ``spectral_tilt`` (dB) — energy above 1.5 kHz minus energy below it. Brightness
  or, read the other way, how pressed vs breathy the delivery is.

**Honesty rules this module keeps** (see the batch design's "name the outcome"
convention):

* Never crash a clone. ``probe`` raises only :class:`ProbeError`, and only when
  the *file* cannot be read at all. Audio that is readable but has nothing to
  measure comes back as a normal dict whose numeric fields are ``None`` and
  whose ``reason`` NAMES the outcome (``too_short``, ``silent``, ``no_speech``,
  ``unvoiced``) — a silent take is not zero pitch, it is unmeasured.
* Partial results are allowed and labelled. A whispered take can have energy and
  tilt but no recoverable f0; it reports both halves rather than throwing the
  measurement away.
* Pure and deterministic. Same bytes in, byte-identical dict out — no sampling,
  no randomness, no clock. ``emotions.resolve`` routes synthesis on these
  numbers, so a probe that wobbled would make synthesis wobble.
"""
from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np

# Bumped when the FEATURE DEFINITIONS change (not on refactors). Stored on every
# row so a later reader can tell measurements apart instead of comparing a v1
# f0 against a v2 one.
VERSION = 1

# The numeric surface, in report order. Public because emotions.py builds its
# comparison space from exactly these keys and the two must not drift.
FIELDS: tuple[str, ...] = (
    "f0_mean", "f0_sd", "energy_rms", "rate_proxy", "spectral_tilt",
)

# 40 ms analysis window / 10 ms hop: long enough to hold two periods of the
# lowest pitch we look for (60 Hz -> 16.7 ms), short enough that the envelope
# still resolves syllables.
_FRAME_MS = 40.0
_HOP_MS = 10.0

# Human speaking range. Anything outside it is an octave error or a hum, and is
# dropped rather than averaged in.
_F0_MIN_HZ = 60.0
_F0_MAX_HZ = 400.0
# Normalised autocorrelation a frame must reach to count as voiced. Below this
# the peak is noise structure, not a period.
_VOICING_MIN = 0.30

# Level conventions taken verbatim from ingest.measure_levels — the other
# WHOLE-FILE gate in this codebase (vad.py's tracked-floor variant is for
# streaming). Copied rather than imported because ingest.py pulls in ffmpeg,
# the registry and the job model, none of which a probe should need; the values
# are asserted against ingest's in test_prosody so the two cannot drift.
_DB_FLOOR = -90.0
_FLOOR_PCT = 10.0            # the quiet tenth of the clip ~ its background
_SPEECH_PCT = 95.0           # the loud twentieth ~ its speech, robust to clicks
_NOISE_MARGIN_DB = 8.0       # threshold sits this far ABOVE the measured floor...
_SPEECH_HEADROOM_DB = 6.0    # ...and never closer than this to the speech level
_SILENT_DBFS = -55.0         # louder than this is audio; quieter is silence
_THRESHOLD_CLAMP = (-75.0, -12.0)

# Shorter than this and the frame count is too small for an envelope to mean
# anything. Named as `too_short` rather than guessed at.
_MIN_SECONDS = 0.25

# Band split for spectral_tilt.
_TILT_SPLIT_HZ = 1500.0

# Envelope smoothing (frames) and the fraction of mean speech energy a maximum
# must clear to count as a syllable event.
_ENVELOPE_SMOOTH = 5
_PEAK_REL_FLOOR = 0.5

_EPS = 1e-12


class ProbeError(ValueError):
    """The file could not be read as audio at all.

    The ONLY exception ``probe`` raises. Everything that is merely
    unmeasurable comes back as a ``reason``-tagged result instead, because a
    clone must never fail over a measurement (batch design C2).
    """


def _skipped(reason: str) -> dict:
    """A well-formed result that measured nothing, and says which nothing."""
    out: dict = {f: None for f in FIELDS}
    out["version"] = VERSION
    out["reason"] = reason
    return out


def _read_mono(wav_path: "str | Path") -> tuple[np.ndarray, int]:
    """Float32 mono in [-1, 1] plus its sample rate.

    Accepts the sample widths ``wave`` can actually hand us (8/16/32-bit PCM);
    anything else is a named ProbeError rather than a silent misread.
    """
    try:
        with wave.open(str(wav_path), "rb") as w:
            rate = w.getframerate()
            channels = w.getnchannels()
            width = w.getsampwidth()
            raw = w.readframes(w.getnframes())
    except (wave.Error, OSError, EOFError) as exc:
        raise ProbeError(f"unreadable wav: {exc}") from exc

    if rate <= 0:
        raise ProbeError("wav declares a zero sample rate")
    if channels <= 0:
        raise ProbeError("wav declares zero channels")

    if width == 1:  # 8-bit PCM is UNSIGNED, unlike every other width
        data = (np.frombuffer(raw, dtype="<u1").astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ProbeError(f"unsupported sample width: {width * 8}-bit")

    if channels > 1:
        usable = (data.size // channels) * channels
        data = data[:usable].reshape(-1, channels).mean(axis=1)
    return np.ascontiguousarray(data, dtype=np.float32), int(rate)


def _windows(samples: np.ndarray, size: int, hop: int) -> np.ndarray:
    """Frames as a 2-D array. Whole frames only — a partial tail is dropped
    rather than zero-padded, which would fake a quiet frame at the end."""
    if samples.size < size:
        return np.empty((0, size), dtype=np.float32)
    count = 1 + (samples.size - size) // hop
    idx = np.arange(size)[None, :] + (np.arange(count)[:, None] * hop)
    return samples[idx]


def _db(values: np.ndarray) -> np.ndarray:
    return np.maximum(20.0 * np.log10(np.maximum(values, _EPS)), _DB_FLOOR)


def _f0(frame: np.ndarray, rate: int) -> float | None:
    """Autocorrelation pitch for one frame, or None when it isn't voiced.

    FFT autocorrelation (not np.correlate) so the cost stays flat as the window
    grows, with parabolic interpolation around the peak — without it the pitch
    is quantised to integer lags, which at 24 kHz is ~7 Hz of avoidable error at
    the top of the range and would show up as fake f0_sd.
    """
    n = frame.size
    if n < 4:
        return None
    x = frame.astype(np.float64)
    x = (x - x.mean()) * np.hanning(n)
    if float(np.dot(x, x)) <= _EPS:
        return None

    size = 1 << int(math.ceil(math.log2(2 * n)))
    spec = np.fft.rfft(x, size)
    ac = np.fft.irfft(spec * np.conjugate(spec), size)[:n]
    r0 = float(ac[0])
    if r0 <= _EPS:
        return None

    lag_min = max(1, int(math.floor(rate / _F0_MAX_HZ)))
    lag_max = min(n - 1, int(math.ceil(rate / _F0_MIN_HZ)))
    if lag_max <= lag_min + 1:
        return None

    seg = ac[lag_min:lag_max + 1]
    k = int(np.argmax(seg))
    if float(seg[k]) / r0 < _VOICING_MIN:
        return None

    lag = float(lag_min + k)
    if 0 < k < seg.size - 1:  # parabolic refinement around the discrete peak
        y0, y1, y2 = float(seg[k - 1]), float(seg[k]), float(seg[k + 1])
        denom = y0 - 2.0 * y1 + y2
        if abs(denom) > _EPS:
            shift = 0.5 * (y0 - y2) / denom
            if -1.0 < shift < 1.0:
                lag += shift
    if lag <= 0.0:
        return None
    f0 = rate / lag
    return float(f0) if _F0_MIN_HZ <= f0 <= _F0_MAX_HZ else None


def _rate_proxy(envelope: np.ndarray, speech_seconds: float) -> float | None:
    """Amplitude-envelope maxima per second of speech.

    Named a proxy in the payload as well as here: it counts loudness events, so
    it tracks syllable rate for ordinary speech and over-counts for a breathy
    or noisy take. Good enough to order two takes by pace, which is all
    ``emotions`` asks of it.
    """
    if speech_seconds <= 0.0 or envelope.size < 3:
        return None
    smooth = envelope
    if envelope.size >= _ENVELOPE_SMOOTH:
        kernel = np.ones(_ENVELOPE_SMOOTH, dtype=np.float64) / _ENVELOPE_SMOOTH
        smooth = np.convolve(envelope.astype(np.float64), kernel, mode="same")
    floor = float(np.mean(smooth)) * _PEAK_REL_FLOOR
    mid = smooth[1:-1]
    peaks = int(np.count_nonzero(
        (mid > smooth[:-2]) & (mid >= smooth[2:]) & (mid >= floor)))
    return float(peaks) / speech_seconds


def _spectral_tilt(speech: np.ndarray, rate: int) -> float | None:
    """Mean (high-band - low-band) energy in dB across the speech frames."""
    if speech.shape[0] == 0:
        return None
    n = speech.shape[1]
    window = np.hanning(n)
    spec = np.fft.rfft(speech.astype(np.float64) * window[None, :], axis=1)
    power = np.abs(spec) ** 2
    freqs = np.fft.rfftfreq(n, d=1.0 / rate)
    low = freqs < _TILT_SPLIT_HZ
    high = ~low
    if not low.any() or not high.any():
        return None  # sample rate too low to have two bands to compare
    low_e = power[:, low].sum(axis=1)
    high_e = power[:, high].sum(axis=1)
    usable = (low_e > _EPS) | (high_e > _EPS)
    if not usable.any():
        return None
    tilt = 10.0 * np.log10(
        (high_e[usable] + _EPS) / (low_e[usable] + _EPS))
    return float(np.mean(tilt))


def probe(wav_path: "str | Path") -> dict:
    """Measure one recording. Batch design contract C2.

    Returns ``{f0_mean, f0_sd, energy_rms, rate_proxy, spectral_tilt,
    version}``, every numeric field ``float | None``, plus a ``reason`` string
    ONLY when something could not be measured. Raises :class:`ProbeError` and
    nothing else, and only for a file that is not readable audio.
    """
    samples, rate = _read_mono(wav_path)
    if samples.size == 0:
        return _skipped("empty")
    if samples.size / float(rate) < _MIN_SECONDS:
        return _skipped("too_short")

    size = max(4, int(round(rate * _FRAME_MS / 1000.0)))
    hop = max(1, int(round(rate * _HOP_MS / 1000.0)))
    frames = _windows(samples, size, hop)
    if frames.shape[0] == 0:
        return _skipped("too_short")

    rms = np.sqrt(np.mean(np.square(frames.astype(np.float64)), axis=1))
    if float(np.max(rms)) <= 0.0:
        return _skipped("silent")  # digital silence, not "zero pitch"

    # The gate threshold is DERIVED from this recording, never hardcoded — and it
    # is derived the way ingest.measure_levels does it, from BOTH ends: a low
    # percentile is the background, a high one is the speech. The speech term is
    # what makes this safe on the input it actually gets: `clean.wav` is
    # loudnorm'd and mostly voiced, so its level is nearly flat, and a
    # floor-only threshold (floor + margin, clamped up to -12 dBFS) would gate
    # the entire recording out and report a perfectly good take as unmeasurable.
    db = _db(rms)
    floor_db = float(np.percentile(db, _FLOOR_PCT))
    speech_db = float(np.percentile(db, _SPEECH_PCT))
    if speech_db <= _SILENT_DBFS:
        # Same verdict ingest.detect_speech gives: its loudest moment is silence.
        return _skipped("silent")
    threshold_db = min(floor_db + _NOISE_MARGIN_DB,
                       speech_db - _SPEECH_HEADROOM_DB)
    threshold_db = min(max(threshold_db, _THRESHOLD_CLAMP[0]),
                       _THRESHOLD_CLAMP[1])
    mask = db >= threshold_db
    if not bool(mask.any()):
        # Unreachable with the derivation above (the 95th percentile always
        # clears its own headroom); kept because a named outcome is cheaper than
        # a division by zero if the constants are ever retuned.
        return _skipped("no_speech")

    speech = frames[mask]
    speech_seconds = float(np.count_nonzero(mask)) * (hop / float(rate))
    energy_rms = float(np.sqrt(np.mean(np.square(speech.astype(np.float64)))))

    pitches = [f for f in (_f0(fr, rate) for fr in speech) if f is not None]
    if pitches:
        arr = np.asarray(pitches, dtype=np.float64)
        f0_mean: float | None = round(float(np.mean(arr)), 2)
        # Population sd: this is the spread of the frames we measured, not an
        # estimate of a wider population.
        f0_sd: float | None = round(float(np.std(arr)), 2)
        reason: str | None = None
    else:
        # Whisper, heavy noise, or a non-speech clip. The other three features
        # are still real, so they are reported and the gap is named.
        f0_mean = f0_sd = None
        reason = "unvoiced"

    tilt = _spectral_tilt(speech, rate)
    pace = _rate_proxy(rms, speech_seconds)

    out: dict = {
        "f0_mean": f0_mean,
        "f0_sd": f0_sd,
        "energy_rms": round(energy_rms, 6),
        "rate_proxy": None if pace is None else round(pace, 3),
        "spectral_tilt": None if tilt is None else round(tilt, 2),
        "version": VERSION,
    }
    if reason is not None:
        out["reason"] = reason
    return out
