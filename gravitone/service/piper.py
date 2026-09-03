"""A second mouth: Piper voices, for the languages Pocket TTS cannot speak.

Pocket TTS is the product — 100 M parameters, zero-shot cloning, and the reason
this service exists. What it is not is multilingual: it speaks English and
French. That is a hard wall for a spoken-interview service used anywhere else,
because the ear underneath (faster-whisper) understands dozens of languages, so
a Czech caller was HEARD correctly and answered in English phonetics. The
conversation worked and the audio was unusable.

Piper (ONNX, CPU, MIT-licensed) closes that gap without weakening the claim this
service makes: still local, still no API key, still no GPU. It is deliberately a
SECOND engine rather than a replacement:

    Pocket TTS  — English/French, voice CLONING, emotion voices. The product.
    Piper       — many languages, fixed voices, no cloning. The fallback that
                  makes a non-English conversation possible at all.

A voice is a pair of files in ``piper_voices/`` (``NAME.onnx`` +
``NAME.onnx.json``), which is what ``python -m piper.download_voices`` writes,
so adding Czech is a download and not a code change. Nothing here is required:
with an empty directory this module reports no voices and every caller falls
through to the Pocket TTS pool exactly as before.

**One synthesis at a time per process.** Same reasoning as service/stt.py: the
core budget is already pinned to the Pocket TTS workers, so a second
unsynchronized ONNX session would contend with the engine it is standing in for.
"""
from __future__ import annotations

import io
import logging
import threading
import time
import wave
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from service.config import SETTINGS

logger = logging.getLogger("gravitone.piper")

# Loaded voices, most-recently-used last. Bounded because each ONNX session is
# tens of megabytes resident and a long-lived process should not accumulate
# every voice anyone ever asked for.
_CACHE: "OrderedDict[str, object]" = OrderedDict()
_CACHE_MAX = 3
_LOAD_LOCK = threading.Lock()
_RUN_LOCK = threading.Lock()

_INSTALL_HINT = (
    "Piper voices need the piper-tts package, which is not installed. Install it "
    "with `pip install -r requirements.txt` (or `pip install piper-tts`)."
)


@dataclass(frozen=True)
class PiperVoiceInfo:
    voice_id: str          # the file stem, e.g. "cs_CZ-jirka-medium"
    language: str          # derived from the name, e.g. "cs"
    path: Path


class PiperUnavailable(RuntimeError):
    """Piper is not installed, or a voice file could not be loaded.

    Authored for the caller: says what to install or download.
    """


def voices_dir() -> Path:
    return Path(SETTINGS.piper_voices_dir)


def _language_of(voice_id: str) -> str:
    """"cs_CZ-jirka-medium" -> "cs". Piper names start with a locale."""
    head = voice_id.split("-", 1)[0]
    return head.split("_", 1)[0].lower()


def list_voices() -> list[PiperVoiceInfo]:
    """Every Piper voice on disk. Empty is a valid installation."""
    d = voices_dir()
    if not d.is_dir():
        return []
    found = []
    for path in sorted(d.glob("*.onnx")):
        # The .json carries the sample rate and phoneme map; without it Piper
        # cannot load the voice, so half a download is not offered as a voice.
        if not path.with_suffix(".onnx.json").is_file():
            logger.warning("piper voice %s has no .onnx.json beside it; skipping",
                           path.name)
            continue
        found.append(PiperVoiceInfo(path.stem, _language_of(path.stem), path))
    return found


def has_voice(voice_id: str) -> bool:
    """Whether this id names a Piper voice — the dispatch test callers use."""
    return any(v.voice_id == voice_id for v in list_voices())


def voice_for_language(language: str) -> str | None:
    """A Piper voice that speaks ``language``, or None.

    How an agent gets a usable voice without naming a file: a Czech agent asks
    for "cs" and gets whichever Czech voice is installed.
    """
    if not language:
        return None
    want = language.split("-", 1)[0].lower()
    return next((v.voice_id for v in list_voices() if v.language == want), None)


def prewarm(languages: "Iterable[str]" = (), voice_ids: "Iterable[str]" = ()) -> dict:
    """Resolve and LOAD voices before a conversation needs one. Blocking.

    A cold ONNX load is a second or two. Paying it at connect is invisible (the
    caller is listening to a greeting); paying it on the first sentence after the
    caller switches language is the one moment the feature is being judged. So a
    session that declares a second language warms it here, off the event loop,
    the same way ``convai._warm_ears`` warms the transcriber.

    Reports rather than raises, for the same reason ``_warm_ears`` does: this is
    an optimization, and its failure mode has to be "the first switched sentence
    is slow", never "the conversation does not start". ``missing`` is also the
    honest answer to "can this replica actually speak that?" — the demand signal
    that says which voice to download.

    At most ``_CACHE_MAX`` voices are warmed: warming more than the LRU holds
    would evict what was just loaded, so the extras are reported as ``skipped``
    instead of being loaded and thrown away.
    """
    wanted: list[tuple[str, str]] = []
    missing: list[str] = []
    for language in languages:
        tag = (language or "").split("-", 1)[0].lower()
        if not tag:
            continue
        found = voice_for_language(tag)
        if found is None:
            missing.append(tag)
        elif found not in [v for _, v in wanted]:
            wanted.append((tag, found))
    for voice_id in voice_ids:
        if voice_id and voice_id not in [v for _, v in wanted]:
            wanted.append((_language_of(voice_id), voice_id))

    warmed: dict[str, str] = {}
    for language, voice_id in wanted[:_CACHE_MAX]:
        try:
            _load(voice_id)
        except PiperUnavailable as exc:
            logger.warning("piper: could not pre-load '%s' (%s)", voice_id, exc)
            missing.append(language)
            continue
        warmed[language] = voice_id
    return {"warmed": warmed, "missing": sorted(set(missing)),
            "skipped": [v for _, v in wanted[_CACHE_MAX:]]}


def _load(voice_id: str):
    cached = _CACHE.get(voice_id)
    if cached is not None:
        _CACHE.move_to_end(voice_id)
        return cached
    with _LOAD_LOCK:
        cached = _CACHE.get(voice_id)
        if cached is not None:
            _CACHE.move_to_end(voice_id)
            return cached
        info = next((v for v in list_voices() if v.voice_id == voice_id), None)
        if info is None:
            available = ", ".join(v.voice_id for v in list_voices()) or "none"
            raise PiperUnavailable(
                f"no Piper voice '{voice_id}' in {voices_dir()}. Installed: "
                f"{available}. Download one with `python -m piper.download_voices "
                f"--download-dir {voices_dir()} {voice_id}`.")
        try:
            from piper import PiperVoice
        except ImportError as exc:
            raise PiperUnavailable(_INSTALL_HINT) from exc
        t0 = time.perf_counter()
        try:
            voice = PiperVoice.load(str(info.path))
        except Exception as exc:  # noqa: BLE001 - a load failure must SAY so
            raise PiperUnavailable(
                f"could not load the Piper voice '{voice_id}' "
                f"({type(exc).__name__}: {exc})") from exc
        logger.info("piper voice '%s' loaded in %.2fs", voice_id,
                    time.perf_counter() - t0)
        _CACHE[voice_id] = voice
        _CACHE.move_to_end(voice_id)
        if len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
        return voice


def synthesize_pcm(voice_id: str, text: str) -> tuple[bytes, int]:
    """``text`` -> (PCM16 mono bytes, sample rate). Blocking; call it on a thread.

    Piper voices synthesize at their own rate (22 050 Hz for the *-medium set),
    which is returned rather than resampled here — the caller knows what rate it
    wants, and resampling twice is worse than resampling once.
    """
    text = (text or "").strip()
    if not text:
        return b"", SETTINGS.convai_audio_rate
    voice = _load(voice_id)
    with _RUN_LOCK:
        chunks = list(voice.synthesize(text))
    if not chunks:
        return b"", SETTINGS.convai_audio_rate
    return b"".join(c.audio_int16_bytes for c in chunks), int(chunks[0].sample_rate)


def synthesize_wav(voice_id: str, text: str) -> tuple[bytes, int]:
    """Same, wrapped in a WAV container — the shape the HTTP routes pass around."""
    pcm, rate = synthesize_pcm(voice_id, text)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue(), rate


def info() -> dict:
    """What this replica can speak beyond Pocket TTS, for /health-style reporting."""
    voices = list_voices()
    return {"directory": str(voices_dir()),
            "voices": [v.voice_id for v in voices],
            "languages": sorted({v.language for v in voices})}
