"""Is this the same voice — one speaker embedding, and the one question it answers.

``diarize.py`` already downloads and loads a WeSpeaker CAM++ embedder to decide
*who spoke when*. That same 29 MB model answers a question the clone pipeline
could never ask before: **does the voice we just produced sound like the person
who recorded it?** Until now the only verification in the whole clone path was
``export_stems._export_one``'s load-back — proof the file parses, not proof it
resembles anybody. This module is the measurement half; ``ingest.py`` is the
caller that uses it.

WHAT IT MEASURES, AND WHAT IT DOES NOT
--------------------------------------
Cosine similarity between two speaker embeddings is **identity**, not quality.
A clone can score high and still have wooden prosody, a wrong pace or an audible
splice. Every payload this feeds says "identity" for that reason, and never
"quality" or "score out of 100" — presenting a proxy as the thing itself would
be a lie in the product's voice. The number is comparable only against numbers
produced the same way (same model, same audio path).

Also inherited from ``diarize.py``, measured there and not re-litigated here:
speaker embeddings are **reliable on recorded humans and unreliable on synthetic
speech** — two clips of one TTS voice can land further apart than clips of two
different people. So a similarity computed between a synthesized calibration
line and its reference stem is weaker evidence than one computed between two
recordings of a person, and the pipeline treats it as advisory: it is reported,
never used to refuse a clone. Calibrating a refusal threshold is deliberately
NOT done here (it needs a fixture set; see ``docs/harness/moonshot-2026-07-30/
cloning-ingest.md`` step 5).

DISCIPLINE (mirrors diarize.py deliberately)
--------------------------------------------
* Lazy import of ``sherpa_onnx`` and lazy model load, behind ``_LOAD_LOCK``, so
  importing this module costs nothing and works on a box with neither.
* One embedding at a time (``_RUN_LOCK``): the core budget belongs to the
  synthesis workers, exactly as ``stt.py`` / ``piper.py`` / ``diarize.py`` argue.
* ``Unavailable`` names what to install or download; ``unavailable_reason()``
  hands that same sentence to callers that want to *report* the degrade instead
  of raising it (the ingest pipeline's "name the outcome" style).

    python -m service.diarize --download        # the model, once (~29 MB)
    python -m service.voiceprint a.wav b.wav    # similarity between two clips
"""
from __future__ import annotations

import logging
import threading
import time
import wave
from pathlib import Path

import numpy as np

from service import diarize
from service.config import SETTINGS

logger = logging.getLogger("gravitone.voiceprint")

# The embedder's input rate. Model-dictated, not a preference.
TARGET_RATE = 16000
VERSION = 1

# Below this there is not enough voiced audio for an embedding to mean anything;
# the extractor would happily return a vector anyway.
MIN_SECONDS = 0.4

_EXTRACTOR = None
_EXTRACTOR_KEY: tuple | None = None
_LOAD_LOCK = threading.Lock()
_RUN_LOCK = threading.Lock()

_INSTALL_HINT = (
    "speaker identity measurement needs sherpa-onnx, which is not installed. "
    "Install it with `pip install -r requirements.txt` (or `pip install "
    "sherpa-onnx`).")


class Unavailable(RuntimeError):
    """sherpa-onnx or the embedding model is missing.

    Authored for the caller, like ``diarize.DiarizationUnavailable``: the message
    says what to install or download, because it is shown to an operator.
    """


# ---------------------------------------------------------------------------
# Availability (answerable without loading anything)
# ---------------------------------------------------------------------------
def model_path() -> Path:
    """The SAME file diarize.py uses — one download serves both."""
    return diarize.embedding_path()


def model_present() -> bool:
    return model_path().is_file()


def unavailable_reason() -> str | None:
    """Why a measurement would fail right now, or None if it would work.

    The reporting twin of raising ``Unavailable``: the clone pipeline must be
    able to publish "identity was not measured, and here is why" without a
    try/except around every payload it builds.
    """
    try:
        import sherpa_onnx  # noqa: F401
    except ImportError:
        return _INSTALL_HINT
    if not model_present():
        return (f"the speaker embedding model is not in {diarize.models_dir()}. "
                "Fetch it with `python -m service.diarize --download` (~29 MB, "
                "no account needed).")
    return None


def available() -> bool:
    """Whether an embedding would work right now, without computing one."""
    return unavailable_reason() is None


def info() -> dict:
    reason = unavailable_reason()
    return {"version": VERSION, "model": str(model_path()),
            "model_present": model_present(),
            "available": reason is None, "reason": reason,
            # Restated in every payload this appears in, on purpose (see the
            # module docstring): the number is identity, not quality.
            "measures": "speaker identity (embedding cosine similarity), "
                        "not perceptual quality"}


# ---------------------------------------------------------------------------
# Audio in
# ---------------------------------------------------------------------------
def _resample(samples: "np.ndarray", src_rate: int) -> "np.ndarray":
    """Linear resample to TARGET_RATE.

    No anti-alias filter, on purpose: this audio is never listened to, only
    embedded, and BOTH sides of every comparison go through this identical path,
    so whatever the interpolation costs it costs symmetrically. Do not reuse this
    for audio a human will hear — ``engine.resample_pcm16`` (polyphase) is that.
    """
    if src_rate == TARGET_RATE or samples.size == 0:
        return samples
    n_out = max(1, int(round(samples.size * TARGET_RATE / float(src_rate))))
    src_idx = np.linspace(0.0, samples.size - 1, n_out, dtype=np.float64)
    return np.interp(src_idx, np.arange(samples.size), samples).astype(np.float32)


def read_samples(wav_path: str | Path) -> "np.ndarray":
    """A wav file as float32 mono in [-1, 1] at TARGET_RATE.

    Accepts the 24 kHz mono 16-bit this pipeline produces, and also 8/32-bit or
    multichannel wavs (channels are averaged) so a caller is never told "no" for
    a file it could have measured. Anything else raises — a silently mis-decoded
    embedding is worse than a named failure.
    """
    path = Path(wav_path)
    with wave.open(str(path), "rb") as w:
        width, channels, rate = w.getsampwidth(), w.getnchannels(), w.getframerate()
        raw = w.readframes(w.getnframes())
    if not raw:
        raise ValueError(f"{path.name} contains no audio frames")
    if width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 1:  # wav 8-bit is UNSIGNED
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"{path.name} is {width * 8}-bit wav, which this "
                         "embedder cannot read (8, 16 or 32-bit expected)")
    if channels > 1:
        usable = (data.size // channels) * channels
        data = data[:usable].reshape(-1, channels).mean(axis=1)
    return _resample(np.ascontiguousarray(data, dtype=np.float32), rate)


# ---------------------------------------------------------------------------
# The extractor
# ---------------------------------------------------------------------------
def _load():
    """The embedder, loaded once and rebuilt only if the model/threads change."""
    global _EXTRACTOR, _EXTRACTOR_KEY
    key = (str(model_path()), int(SETTINGS.diarize_threads))
    if _EXTRACTOR is not None and _EXTRACTOR_KEY == key:
        return _EXTRACTOR
    with _LOAD_LOCK:
        if _EXTRACTOR is not None and _EXTRACTOR_KEY == key:
            return _EXTRACTOR
        try:
            import sherpa_onnx
        except ImportError as exc:
            raise Unavailable(_INSTALL_HINT) from exc
        if not model_present():
            raise Unavailable(unavailable_reason() or "the embedding model is missing")
        t0 = time.perf_counter()
        try:
            extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
                sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                    model=str(model_path()),
                    num_threads=SETTINGS.diarize_threads))
        except Exception as exc:  # noqa: BLE001 - a load failure must SAY so
            raise Unavailable(
                f"could not build the speaker embedder "
                f"({type(exc).__name__}: {exc}). Re-run "
                "`python -m service.diarize --download`.") from exc
        logger.info("speaker embedder loaded in %.2fs", time.perf_counter() - t0)
        _EXTRACTOR, _EXTRACTOR_KEY = extractor, key
        return _EXTRACTOR


def embed(wav_path: str | Path) -> "np.ndarray":
    """The speaker embedding of one wav file.

    Raises ``Unavailable`` when sherpa-onnx or the model is absent, and
    ``ValueError`` when the file is readable but unusable (empty, far too short,
    a format the reader refuses). Blocking; call it off the event loop.
    """
    # Availability is checked FIRST, before the file is even opened: "sherpa-onnx
    # is not installed" is the answer whatever the audio turns out to be, and a
    # caller that gets FileNotFoundError from an un-equipped box learns the wrong
    # thing. The load is cached, so asking costs nothing after the first time.
    extractor = _load()
    samples = read_samples(wav_path)
    if samples.size < int(MIN_SECONDS * TARGET_RATE):
        raise ValueError(
            f"{Path(wav_path).name} is {samples.size / TARGET_RATE:.2f}s — under "
            f"the {MIN_SECONDS:.1f}s an embedding needs to mean anything")
    with _RUN_LOCK:
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=TARGET_RATE, waveform=samples)
        stream.input_finished()
        vector = np.asarray(extractor.compute(stream), dtype=np.float32)
    if vector.size == 0 or not bool(np.isfinite(vector).all()):
        raise ValueError("the embedder returned no usable vector for "
                         f"{Path(wav_path).name}")
    return vector


def similarity(a: "np.ndarray", b: "np.ndarray") -> float:
    """Cosine similarity in [-1, 1] — how much two voices look like one voice.

    Clamped, because float error can hand back 1.0000001 for a vector compared
    with itself and a similarity outside its own range is the kind of detail that
    later gets rendered to a user. A zero vector RAISES instead of scoring 0.0:
    it has no direction, and "0.0" would read as a measured dissimilarity.
    """
    va = np.asarray(a, dtype=np.float64).ravel()
    vb = np.asarray(b, dtype=np.float64).ravel()
    if va.size != vb.size:
        raise ValueError(f"embeddings differ in size ({va.size} vs {vb.size}) — "
                         "they were not produced by the same model")
    na, nb = float(np.linalg.norm(va)), float(np.linalg.norm(vb))
    if na == 0.0 or nb == 0.0:
        raise ValueError("a zero embedding has no direction to compare")
    return float(min(1.0, max(-1.0, float(np.dot(va, vb)) / (na * nb))))


def centroid(vectors: "list[np.ndarray]") -> "np.ndarray":
    """The mean DIRECTION of several embeddings — a speaker's centre of mass.

    Each vector is unit-normalized first, so one loud or long clip cannot pull
    the centre by having a bigger magnitude; the result is normalized too, so it
    is comparable with ``similarity`` against any single embedding.
    """
    units = []
    for v in vectors:
        arr = np.asarray(v, dtype=np.float64).ravel()
        norm = float(np.linalg.norm(arr))
        if norm > 0.0:
            units.append(arr / norm)
    if not units:
        raise ValueError("no usable embeddings to average")
    mean = np.mean(np.stack(units), axis=0)
    norm = float(np.linalg.norm(mean))
    if norm == 0.0:
        # Diametrically opposed vectors cancel: there is no centre, and
        # returning the zero vector would make every later similarity raise.
        raise ValueError("these embeddings have no common direction")
    return (mean / norm).astype(np.float32)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description="Speaker identity between two wav files (and this module's "
                    "readiness).")
    parser.add_argument("wavs", nargs="*", help="two wav files to compare")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(json.dumps(info(), indent=2))
    if len(args.wavs) != 2:
        return 0
    a, b = (embed(w) for w in args.wavs)
    print(f"identity {similarity(a, b):.3f}  "
          "(speaker identity, NOT perceptual quality)")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
